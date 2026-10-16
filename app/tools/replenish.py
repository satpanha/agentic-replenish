"""Tool 3 - smart replenishment: (s, S) policy with safety stock, pack/MOQ rounding, PO drafts."""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np


def z_for(service_level: float) -> float:
    return NormalDist().inv_cdf(min(max(service_level, 0.5), 0.9999))


def decide_order(fc: np.ndarray, sigma: float, lead_time: float, lt_std: float, review_days: int, service_level: float,
                 position: float, pack: int = 1, moq: int = 0, max_cover_days: float | None = None) -> dict:
    """Pure single-SKU periodic-review policy used by both the live tool and the backtest.

    Protection interval is L + R (lead time + review period), because stock is only checked every R days.
      safety stock   = z * sqrt((L+R) * sigma^2 + (mu * sigma_L)^2)
      order-up-to S  = forecast demand over (L+R) + safety stock          (capped by shelf life)
      reorder point  = S - 0.5 * forecast demand over R                   (skip tiny top-ups)
      order qty      = S - inventory position, rounded up to pack size and MOQ
    """
    L = max(int(math.ceil(lead_time)), 1)
    R = max(int(review_days), 1)
    P = L + R
    mu = float(fc[:P].mean()) if len(fc) else 0.0
    ss = z_for(service_level) * math.sqrt(P * sigma**2 + (mu * lt_std) ** 2)
    dem_L = float(fc[:L].sum())
    dem_R = float(fc[L:P].sum())
    S = dem_L + dem_R + ss
    if max_cover_days is not None and mu > 0:
        S = min(S, mu * max_cover_days)
    rop = S - 0.5 * dem_R
    qty = 0
    if position <= rop and S > position:
        raw = S - position
        pack = max(int(pack), 1)
        qty = int(math.ceil(raw / pack) * pack)
        if moq and qty < moq:
            qty = int(math.ceil(moq / pack) * pack)
    return dict(order_qty=qty, reorder_point=round(rop, 1), order_up_to=round(S, 1), safety_stock=round(ss, 1),
                demand_over_lead_time=round(dem_L, 1), position=round(position, 1), triggered=qty > 0)


def build_po_drafts(inv, sup, fcs: dict, service_level: float, review_days: int, supplier_id: str | None = None) -> list[dict]:
    """fcs: sku -> forecast_series() result. Returns one draft per supplier (status is set by the store)."""
    supm = sup.set_index("supplier_id").to_dict("index")
    by_sup: dict[str, list] = {}
    for r in inv.itertuples():
        if supplier_id and r.supplier_id != supplier_id:
            continue
        s = supm[r.supplier_id]
        f = fcs[r.sku]
        shelf = float(r.shelf_life_days) if str(r.shelf_life_days) not in ("", "nan") else None
        d = decide_order(f["forecast"], f["sigma_daily"], s["lead_time_days"], s["lead_time_std_days"], review_days,
                         service_level, r.stock + r.on_order, int(r.pack_size), int(r.moq),
                         max_cover_days=0.8 * shelf if shelf else None)
        if not d["triggered"]:
            continue
        by_sup.setdefault(r.supplier_id, []).append(dict(
            sku=r.sku, name=r.name, qty=d["order_qty"], unit_cost=float(r.unit_cost),
            line_cost=round(d["order_qty"] * float(r.unit_cost), 2), reorder_point=d["reorder_point"],
            safety_stock=d["safety_stock"], position=d["position"], demand_over_lead_time=d["demand_over_lead_time"],
            forecast_method=f["method"], forecast_wape=round(f["wape"], 3),
        ))
    drafts = []
    for sid, lines in by_sup.items():
        total = round(sum(l["line_cost"] for l in lines), 2)
        warn = []
        if total < float(supm[sid]["min_order_value"]):
            warn.append(f"Total {total} is below the supplier minimum order value {supm[sid]['min_order_value']}.")
        drafts.append(dict(supplier_id=sid, supplier_name=supm[sid]["name"], lead_time_days=int(supm[sid]["lead_time_days"]),
                           lines=sorted(lines, key=lambda l: -l["line_cost"]), total_cost=total, warnings=warn,
                           service_level=service_level, review_days=review_days))
    return sorted(drafts, key=lambda d: -d["total_cost"])
