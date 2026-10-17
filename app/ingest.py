"""CSV import into the engine. Validates the canonical schema and cross-table references, then
writes a complete dataset to var/data_imported (missing tables are taken from the active dataset)."""
from __future__ import annotations

import io
import shutil

import pandas as pd

from app import config
from app.service import IMPORTED_DIR_NAME, active_data_dir

SCHEMA = {
    "sales": ["date", "sku", "units"],
    "inventory": ["sku", "name", "category", "supplier_id", "stock", "on_order", "unit_cost", "unit_price", "pack_size", "moq",
                  "shelf_life_days", "earliest_expiry_date"],
    "suppliers": ["supplier_id", "name", "lead_time_days", "lead_time_std_days", "min_order_value"],
}
NUMERIC = {
    "sales": ["units"],
    "inventory": ["stock", "on_order", "unit_cost", "unit_price", "pack_size", "moq"],
    "suppliers": ["lead_time_days", "lead_time_std_days", "min_order_value"],
}
MAX_BYTES = 20_000_000


def imported_dir():
    return config.DB_PATH.parent / IMPORTED_DIR_NAME


def _parse(name: str, text: str) -> tuple[pd.DataFrame | None, list[str]]:
    errs = []
    if len(text.encode()) > MAX_BYTES:
        return None, [f"{name}.csv is larger than 20 MB."]
    try:
        df = pd.read_csv(io.StringIO(text), keep_default_na=False)
    except Exception as ex:
        return None, [f"{name}.csv could not be read: {type(ex).__name__}."]
    df.columns = [c.strip().lower() for c in df.columns]
    missing = [c for c in SCHEMA[name] if c not in df.columns]
    if missing:
        return None, [f"{name}.csv is missing column{'s' if len(missing) > 1 else ''}: {', '.join(missing)}."]
    if df.empty:
        return None, [f"{name}.csv has no rows."]
    for c in NUMERIC[name]:
        v = pd.to_numeric(df[c], errors="coerce")
        bad = int(v.isna().sum())
        if bad:
            errs.append(f"{name}.csv: {bad} non-numeric value{'s' if bad > 1 else ''} in '{c}'.")
        elif (v < 0).any():
            errs.append(f"{name}.csv: negative values in '{c}'.")
    if name == "sales":
        d = pd.to_datetime(df["date"], errors="coerce")
        if d.isna().any():
            errs.append(f"sales.csv: {int(d.isna().sum())} rows with an unreadable date.")
    if name == "inventory":
        if df["sku"].duplicated().any():
            errs.append("inventory.csv: duplicate SKUs.")
        if (pd.to_numeric(df["pack_size"], errors="coerce") < 1).any():
            errs.append("inventory.csv: pack_size must be at least 1.")
    return df[SCHEMA[name]], errs


def validate(files: dict[str, str]) -> dict:
    """files: table name -> CSV text. Returns per-table results and cross-table errors."""
    cur = active_data_dir()
    tables, report, errors = {}, {}, []
    for name in SCHEMA:
        if name in files and files[name]:
            df, errs = _parse(name, files[name])
            report[name] = {"source": "upload", "rows": None if df is None else int(len(df)), "errors": errs}
            errors += errs
            if df is not None:
                tables[name] = df
        else:
            tables[name] = pd.read_csv(cur / f"{name}.csv", keep_default_na=False)
            report[name] = {"source": "current", "rows": int(len(tables[name])), "errors": []}
    if not errors:
        inv, sup, sales = tables["inventory"], tables["suppliers"], tables["sales"]
        unknown_sup = sorted(set(inv["supplier_id"]) - set(sup["supplier_id"]))
        if unknown_sup:
            errors.append(f"inventory.csv references suppliers not in suppliers.csv: {', '.join(unknown_sup[:5])}.")
        no_sales = sorted(set(inv["sku"]) - set(sales["sku"]))
        if no_sales:
            errors.append(f"{len(no_sales)} inventory SKU(s) have no sales history, for example {', '.join(no_sales[:3])}.")
        days = pd.to_datetime(sales["date"]).nunique()
        if days < 21:
            errors.append(f"sales.csv covers {days} days; at least 21 are needed to forecast.")
    return {"ok": not errors, "errors": errors, "tables": report, "_frames": tables}


def apply(files: dict[str, str]) -> dict:
    res = validate(files)
    frames = res.pop("_frames")
    if not res["ok"]:
        return res
    out = imported_dir()
    tmp = out.with_name(out.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for name, df in frames.items():
        df.to_csv(tmp / f"{name}.csv", index=False)
    shutil.rmtree(out, ignore_errors=True)
    tmp.rename(out)
    return res


def reset_to_sample() -> None:
    shutil.rmtree(imported_dir(), ignore_errors=True)
