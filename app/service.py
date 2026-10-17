"""Data layer + engine. One place that loads the canonical tables and runs the three tools."""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from app import config, store
from app.tools import forecast as fc_tool
from app.tools import replenish as rep_tool
from app.tools import risk as risk_tool


IMPORTED_DIR_NAME = "data_imported"


def active_data_dir() -> Path:
    """Imported CSVs (var/data_imported) win over the bundled sample once a complete set exists."""
    imp = config.DB_PATH.parent / IMPORTED_DIR_NAME
    if all((imp / f).exists() for f in ("sales.csv", "inventory.csv", "suppliers.csv")):
        return imp
    return config.DATA_DIR


class Engine:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = Path(data_dir or active_data_dir())
        self.load()

    def load(self) -> None:
        d = self.data_dir
        self.sales = pd.read_csv(d / "sales.csv", parse_dates=["date"])
        self.inv = pd.read_csv(d / "inventory.csv", keep_default_na=False)
        self.sup = pd.read_csv(d / "suppliers.csv")
        self.applied_updates = self._apply_confirmed_updates()
        self.today = (self.sales["date"].max() + timedelta(days=1)).date()
        piv = self.sales.pivot_table(index="date", columns="sku", values="units", aggfunc="sum").sort_index().fillna(0)
        self.series = {sku: piv[sku].values for sku in piv.columns}
        self._fc_cache: dict = {}

    def _apply_confirmed_updates(self) -> list[dict]:
        """Confirmed supplier-document values replace the CSV values (latest confirmation wins)."""
        applied = []
        for u in store.list_updates():
            if u["sku"] and u["field"] in store.SKU_FIELDS:
                m = (self.inv["sku"] == u["sku"]) & (self.inv["supplier_id"] == u["supplier_id"])
                if m.any():
                    self.inv.loc[m, u["field"]] = int(u["new_value"]) if u["field"] != "unit_cost" else float(u["new_value"])
                    applied.append(u)
            elif u["field"] in store.SUPPLIER_FIELDS:
                m = self.sup["supplier_id"] == u["supplier_id"]
                if m.any():
                    self.sup.loc[m, u["field"]] = float(u["new_value"])
                    applied.append(u)
        return applied

    @property
    def is_sample(self) -> bool:
        return self.data_dir.resolve() == Path(config.DATA_DIR).resolve()

    # ---- tool 1 -------------------------------------------------------
    def forecast(self, sku: str):
        if sku not in self.series:
            raise KeyError(f"Unknown SKU {sku}")
        if sku not in self._fc_cache:
            self._fc_cache[sku] = fc_tool.forecast_series(self.series[sku], config.FORECAST_HORIZON)
        return self._fc_cache[sku]

    def forecast_summary(self, sku: str, horizon_days: int = 28) -> dict:
        return fc_tool.summarize(sku, self.forecast(sku), min(int(horizon_days), config.FORECAST_HORIZON))

    # ---- tool 2 -------------------------------------------------------
    def risk_frame(self) -> pd.DataFrame:
        daily = {s: self.forecast(s)["mean_daily"] for s in self.inv["sku"]}
        return risk_tool.assess(self.inv, daily, self.sup, self.today)

    def risk(self, top_n: int = 10) -> dict:
        df = self.risk_frame()
        flagged = df[df.primary_reason != "OK"]
        counts = flagged["primary_reason"].value_counts().to_dict()
        return {"as_of": self.today.isoformat(), "total_skus": int(len(df)), "flagged": int(len(flagged)),
                "counts_by_reason": counts, "top": flagged.head(int(top_n)).astype(object).where(flagged.notna(), None).to_dict("records")}

    # ---- tool 3 -------------------------------------------------------
    def replenish(self, service_level: float | None = None, review_days: int | None = None, supplier_id: str | None = None) -> dict:
        sl = service_level or config.SERVICE_LEVEL
        rd = review_days or config.REVIEW_DAYS
        fcs = {s: self.forecast(s) for s in self.inv["sku"]}
        drafts = rep_tool.build_po_drafts(self.inv, self.sup, fcs, sl, rd, supplier_id)
        return {"as_of": self.today.isoformat(), "service_level": sl, "review_days": rd, "drafts": drafts,
                "total_cost": round(sum(d["total_cost"] for d in drafts), 2), "line_count": sum(len(d["lines"]) for d in drafts)}

    def overview(self) -> dict:
        return {"as_of": self.today.isoformat(), "skus": int(len(self.inv)), "suppliers": int(len(self.sup)),
                "history_days": int(len(next(iter(self.series.values())))),
                "history_start": self.sales["date"].min().date().isoformat(),
                "categories": sorted(self.inv["category"].unique().tolist()),
                "inventory_value": round(float((self.inv.stock * self.inv.unit_cost).sum()), 2)}


_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine()
    return _engine


def reload_engine() -> Engine:
    """Re-read data and confirmed updates (after an import or a supplier-update confirmation)."""
    global _engine
    _engine = Engine()
    return _engine
