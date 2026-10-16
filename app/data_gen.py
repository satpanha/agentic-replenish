"""Synthetic but realistic retail dataset in the canonical schema.

Run:  python -m app.data_gen            (writes app/data_sample/*.csv)

Canonical schema (what any other system needs to map to):
  sales.csv      date, sku, units
  inventory.csv  sku, name, category, supplier_id, stock, on_order, unit_cost, unit_price,
                 pack_size, moq, shelf_life_days, earliest_expiry_date
  suppliers.csv  supplier_id, name, lead_time_days, lead_time_std_days, min_order_value
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

END_DATE = "2026-10-15"
DAYS = 540

SUPPLIERS = [
    ("S1", "Mekong Fresh Foods", 3, 0.5, 150),
    ("S2", "Angkor Beverage Co", 5, 1.0, 200),
    ("S3", "Phnom Penh Household Supply", 7, 1.5, 250),
    ("S4", "Pacific Personal Care", 10, 2.0, 300),
    ("S5", "Siam Snacks Import", 14, 3.0, 400),
]
SUPPLIER_BY_CAT = {"Dairy": "S1", "Beverages": "S2", "Household": "S3", "Personal care": "S4", "Snacks": "S5"}
# category -> (base demand range, weekend uplift, unit cost range, margin range, shelf life, pack sizes, yearly amp)
CATS = {
    "Dairy": ((20, 70), 1.10, (0.8, 3.0), (0.25, 0.40), 21, [6, 12], 0.05),
    "Beverages": ((40, 160), 1.35, (0.4, 1.5), (0.30, 0.50), 180, [12, 24], 0.25),
    "Household": ((6, 40), 1.05, (2.0, 9.0), (0.25, 0.45), None, [6, 10], 0.05),
    "Personal care": ((4, 30), 1.00, (1.5, 8.0), (0.30, 0.55), None, [6, 12], 0.08),
    "Snacks": ((15, 90), 1.25, (0.5, 2.5), (0.30, 0.50), 240, [12, 20], 0.15),
}
PRODUCT_NAMES = {
    "Dairy": ["Fresh Milk 1L", "Yogurt Plain 500g", "Cheese Slices 200g", "Butter 250g", "Chocolate Milk 1L", "Cream 250ml"],
    "Beverages": ["Mineral Water 1.5L", "Cola 330ml", "Green Tea 500ml", "Orange Juice 1L", "Energy Drink 250ml", "Iced Coffee 240ml", "Sparkling Water 500ml"],
    "Household": ["Dish Soap 750ml", "Laundry Powder 2kg", "Trash Bags 30pc", "Floor Cleaner 1L", "Paper Towels 4pk", "Sponges 6pk", "Toilet Paper 12pk"],
    "Personal care": ["Shampoo 400ml", "Toothpaste 150g", "Hand Soap 250ml", "Body Lotion 300ml", "Deodorant 50ml", "Face Wash 100ml", "Razor 3pk"],
    "Snacks": ["Potato Chips 150g", "Instant Noodles 5pk", "Rice Crackers 120g", "Chocolate Bar 80g", "Peanuts 200g", "Cookies 250g", "Dried Mango 100g"],
}
ARCHETYPES = ["ok", "ok", "ok", "ok", "low", "low", "excess", "slow"]  # weights


def generate(out_dir: Path, seed: int = 42) -> dict:
    rng = np.random.default_rng(seed)
    dates = pd.date_range(end=END_DATE, periods=DAYS, freq="D")
    t = np.arange(DAYS)
    dow = dates.dayofweek.values  # 0=Mon
    doy = dates.dayofyear.values

    sup = pd.DataFrame(SUPPLIERS, columns=["supplier_id", "name", "lead_time_days", "lead_time_std_days", "min_order_value"])
    lt = sup.set_index("supplier_id")["lead_time_days"].to_dict()

    inv_rows, sales_rows = [], []
    n = 0
    for cat, names in PRODUCT_NAMES.items():
        (blo, bhi), wk_up, (clo, chi), (mlo, mhi), shelf, packs, yamp = CATS[cat]
        sid = SUPPLIER_BY_CAT[cat]
        for name in names:
            n += 1
            sku = f"SKU{n:03d}"
            arche = rng.choice(ARCHETYPES)
            base = rng.uniform(blo, bhi) * (0.12 if arche == "slow" else 1.0)
            trend = rng.choice([-0.0006, 0.0, 0.0, 0.0008, 0.0015])  # per-day relative drift
            phase = rng.uniform(0, 2 * np.pi)
            weekly = np.where(dow >= 5, wk_up, 1.0) * (1 + 0.04 * np.sin(dow))
            yearly = 1 + yamp * np.sin(2 * np.pi * doy / 365.25 + phase)
            mu = base * weekly * yearly * (1 + trend * t)
            promo = np.ones(DAYS)
            for _ in range(rng.integers(5, 10)):
                s = rng.integers(0, DAYS - 4)
                promo[s : s + rng.integers(2, 5)] = rng.uniform(1.4, 2.1)
            mu = mu * promo
            # Negative-binomial-like overdispersed counts
            k = 12.0
            units = rng.negative_binomial(k, k / (k + mu)).astype(int)
            for d, u in zip(dates, units):
                sales_rows.append((d.date().isoformat(), sku, int(u)))

            cost = round(rng.uniform(clo, chi), 2)
            price = round(cost / (1 - rng.uniform(mlo, mhi)), 2)
            pack = int(rng.choice(packs))
            moq = pack * int(rng.choice([1, 2, 4]))
            daily = float(units[-28:].mean())
            L = lt[sid]
            cover = {
                "ok": rng.uniform(1.6, 2.8) * (L + 7),
                "low": rng.uniform(0.25, 0.8) * L,
                "excess": rng.uniform(150, 300),
                "slow": rng.uniform(110, 260),
            }[arche]
            stock = int(max(0, round(daily * cover)))
            on_order = int(round(daily * L * rng.uniform(0.3, 0.9) / pack) * pack) if arche in ("ok", "low") and rng.random() < 0.35 else 0
            expiry = ""
            if shelf:
                # most perishable lots have ample runway; planted exceptions for demo
                days_left = int(rng.uniform(0.2, 0.5) * shelf) if arche in ("excess", "slow") or rng.random() < 0.12 else int(rng.uniform(0.6, 1.0) * shelf)
                expiry = (pd.Timestamp(END_DATE) + pd.Timedelta(days=days_left)).date().isoformat()
            inv_rows.append(
                dict(sku=sku, name=name, category=cat, supplier_id=sid, stock=stock, on_order=on_order, unit_cost=cost,
                     unit_price=price, pack_size=pack, moq=moq, shelf_life_days=shelf if shelf else "", earliest_expiry_date=expiry)
            )

    out_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(sales_rows, columns=["date", "sku", "units"]).to_csv(out_dir / "sales.csv", index=False)
    pd.DataFrame(inv_rows).to_csv(out_dir / "inventory.csv", index=False)
    sup.to_csv(out_dir / "suppliers.csv", index=False)
    return {"skus": len(inv_rows), "days": DAYS, "suppliers": len(sup), "out_dir": str(out_dir)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="app/data_sample")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    print(generate(Path(a.out), a.seed))
