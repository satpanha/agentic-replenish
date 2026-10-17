"""Overview payload for the StockPulse command center.

One call returns every number the Overview shows, computed by the same engine the tools use, so the
table, metrics, chart and alerts can never disagree with each other or with the agent.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np

from app import config, store
from app.service import Engine
from app.tools.forecast import HOLDOUT, wape

HISTORY_DAYS = 56
HORIZON_DAYS = 28


def _num(v, nd: int = 2):
    """JSON-safe float (NaN/None -> None)."""
    if v is None:
        return None
    f = float(v)
    return None if math.isnan(f) else round(f, nd)


def _sma14_wape(y: np.ndarray) -> float | None:
    """Holdout WAPE of the 14-day simple moving average, scored on the same window as the model."""
    if len(y) < HOLDOUT + 14:
        return None
    train, test = y[:-HOLDOUT], y[-HOLDOUT:]
    return round(wape(test, np.full(HOLDOUT, train[-14:].mean())), 4)


def build(e: Engine) -> dict:
    risk = e.risk_frame()
    rep = e.replenish()
    lines = {l["sku"]: l for d in rep["drafts"] for l in d["lines"]}
    inv = e.inv.set_index("sku")
    sup = e.sup.set_index("supplier_id")

    pos = [po for po in store.list_pos() if po["status"] != "superseded"]
    products = []
    for r in risk.itertuples():
        i, s, f = inv.loc[r.sku], sup.loc[r.supplier_id], e.forecast(r.sku)
        y = e.series[r.sku]
        d = float(r.daily_forecast)
        L = float(r.lead_time_days)
        cover_pos = float(r.days_cover_incl_pipeline)
        margin = float(i.unit_price) - float(i.unit_cost)
        line = lines.get(r.sku)
        products.append({
            "sku": r.sku, "name": r.name, "category": i.category, "supplier_id": r.supplier_id,
            "stock": int(r.stock), "on_order": int(r.on_order),
            "unit_cost": _num(i.unit_cost), "unit_price": _num(i.unit_price),
            "pack_size": int(i.pack_size), "moq": int(i.moq),
            "shelf_life_days": _num(i.shelf_life_days or None, 0),
            "earliest_expiry_date": i.earliest_expiry_date or None,
            "days_to_expiry": None if r.days_to_expiry is None or (isinstance(r.days_to_expiry, float) and math.isnan(r.days_to_expiry)) else int(r.days_to_expiry),
            "daily_forecast": _num(d), "days_cover": _num(r.days_cover, 1), "days_cover_incl_pipeline": _num(cover_pos, 1),
            "lead_time_days": _num(L, 1), "lead_time_std_days": _num(s.lead_time_std_days, 1),
            "primary_reason": r.primary_reason, "reasons": list(r.all_reasons), "risk_score": _num(r.risk_score, 1),
            "value_at_risk": _num(r.value_at_risk),
            # gross margin on demand that stock + open orders cannot cover before the earliest new delivery
            "margin_at_risk": round(d * max(0.0, L - cover_pos) * margin, 2),
            # cost value of stock beyond the excess-cover threshold
            "excess_capital": round(max(0.0, cover_pos - config.EXCESS_COVER_DAYS) * d * float(i.unit_cost), 2),
            "forecast": {
                "method": f["method"], "wape": _num(f["wape"], 4), "sma14_wape": _sma14_wape(y),
                "sigma_daily": _num(f["sigma_daily"]),
                "history": [int(v) for v in y[-HISTORY_DAYS:]],
                "values": [_num(v, 1) for v in f["forecast"][:HORIZON_DAYS]],
            },
            "updates": [{k: u[k] for k in ("id", "field", "old_value", "new_value", "effective", "source_doc", "confirmed_at", "confirmed_by")}
                        for u in e.applied_updates if u["sku"] == r.sku or (u["sku"] is None and u["supplier_id"] == r.supplier_id)],
            "orders": [{"id": po["id"], "status": po["status"], "qty": l["qty"], "line_cost": l["line_cost"], "created_at": po["created_at"],
                        "updated_at": po["updated_at"], "events": [ev for ev in po["events"]][-3:]}
                       for po in pos for l in po["lines"] if l["sku"] == r.sku][:5],
            "recommendation": None if not line else {
                "qty": line["qty"], "line_cost": line["line_cost"], "reorder_point": line["reorder_point"],
                "safety_stock": line["safety_stock"], "demand_over_lead_time": line["demand_over_lead_time"],
            },
        })

    return {
        "as_of": e.today.isoformat(),
        "history_start": (e.today - timedelta(days=HISTORY_DAYS)).isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "is_sample_data": e.is_sample,
        "policy": {"service_level": rep["service_level"], "review_days": rep["review_days"],
                   "excess_cover_days": config.EXCESS_COVER_DAYS},
        "suppliers": [{"supplier_id": sid, "name": s["name"], "lead_time_days": _num(s["lead_time_days"], 1),
                       "lead_time_std_days": _num(s["lead_time_std_days"], 1), "min_order_value": _num(s["min_order_value"])}
                      for sid, s in sup.iterrows()],
        "drafts": [{"supplier_id": d["supplier_id"], "total_cost": d["total_cost"], "warnings": d["warnings"],
                    "skus": [l["sku"] for l in d["lines"]]} for d in rep["drafts"]],
        "products": products,
    }
