"""Tool 4 - budget-constrained replenishment (deterministic greedy heuristic, NOT a MILP solver).

Starts from the unconstrained order-up-to quantities of tool 3, then fits them into a budget:
  1. Every triggered line gets a *protection* quantity first: demand until the next review delivery
     (lead time + review period) minus inventory position, without the safety buffer, rounded up
     to pack size and MOQ. Lines are funded in priority order:
       tier 0  stock + open orders run out before a new delivery can arrive (cover < lead time)
       tier 1  run out before the delivery after next review (cover < lead time + review period)
       tier 2  everything else the policy triggers
     and, inside a tier, by gross margin protected per dollar spent.
  2. Remaining budget upgrades funded lines to their full quantity (with safety stock), same order.
  3. A line that cannot get even its protection quantity is deferred, with the shortfall it implies.
Quantities, costs and totals come only from here; an LLM may explain them but never changes them.
"""
from __future__ import annotations

import math

from app.tools.replenish import decide_order, z_for

ASSUMPTIONS = [
    "Greedy heuristic, not an optimal solver: lines are funded one at a time in priority order.",
    "Priority: products that run out before a new delivery first, then those that run out before the next review, then the rest; ties broken by gross margin protected per dollar.",
    "Reduced lines keep the shelf stocked until the next review delivery but carry no safety stock.",
    "Pack size and MOQ are always respected, so a line is either funded at a valid quantity or deferred.",
    "No storage or shelf-space limits are on file, so none are applied.",
]


def _round_up(q: float, pack: int, moq: int) -> int:
    if q <= 0:
        return 0
    pack = max(int(pack), 1)
    n = int(math.ceil(q / pack) * pack)
    if moq and n < moq:
        n = int(math.ceil(moq / pack) * pack)
    return n


def optimize(engine, budget: float, service_level: float | None = None, review_days: int | None = None,
             lead_time_overrides: dict | None = None) -> dict:
    from app import config

    sl = service_level or config.SERVICE_LEVEL
    R = int(review_days or config.REVIEW_DAYS)
    lto = {k: float(v) for k, v in (lead_time_overrides or {}).items()}
    sup = engine.sup.set_index("supplier_id").to_dict("index")
    lines = []
    for r in engine.inv.itertuples():
        s = sup[r.supplier_id]
        f = engine.forecast(r.sku)
        L = lto.get(r.supplier_id, float(s["lead_time_days"]))
        shelf = float(r.shelf_life_days) if str(r.shelf_life_days) not in ("", "nan") else None
        position = float(r.stock + r.on_order)
        d = decide_order(f["forecast"], f["sigma_daily"], L, float(s["lead_time_std_days"]), R, sl, position,
                         int(r.pack_size), int(r.moq), max_cover_days=0.8 * shelf if shelf else None)
        if not d["triggered"]:
            continue
        Li = max(int(math.ceil(L)), 1)
        fc = f["forecast"]
        dem_lr = float(fc[:Li + R].sum())
        mu = float(fc[:28].mean()) or 1e-6
        cover = position / mu
        protect = _round_up(dem_lr - position, int(r.pack_size), int(r.moq))
        protect = min(protect, d["order_qty"])  # 0 = only the safety buffer is missing
        margin = float(r.unit_price) - float(r.unit_cost)
        short_if_deferred = max(0.0, dem_lr - position)
        tier = 0 if cover < L else 1 if cover < L + R else 2
        lines.append(dict(
            sku=r.sku, name=r.name, supplier_id=r.supplier_id, supplier_name=s["name"], tier=tier,
            unit_cost=float(r.unit_cost), unit_price=float(r.unit_price), pack_size=int(r.pack_size), moq=int(r.moq),
            lead_time_days=L, review_days=R, position=round(position, 1), daily_forecast=round(mu, 2), cover_days=round(cover, 1),
            recommended_qty=d["order_qty"], protection_qty=int(protect), safety_stock=d["safety_stock"],
            reorder_point=d["reorder_point"], order_up_to=d["order_up_to"], demand_over_lead_time=d["demand_over_lead_time"],
            demand_over_review=round(dem_lr - d["demand_over_lead_time"], 1),
            shortfall_units_if_deferred=round(short_if_deferred, 1),
            margin_at_risk_if_deferred=round(short_if_deferred * margin, 2),
            value_density=(short_if_deferred * margin) / max(protect * float(r.unit_cost), 1e-6),
        ))

    order = sorted(lines, key=lambda l: (l["tier"], -l["value_density"]))
    left = float(budget)
    for l in order:  # pass 1: protection quantities
        cost = l["protection_qty"] * l["unit_cost"]
        if cost <= left + 1e-9:
            l["qty"], left = l["protection_qty"], left - cost
        else:
            l["qty"] = 0
    for l in order:  # pass 2: upgrade to the full policy quantity
        if l["qty"] < l["recommended_qty"] and (l["qty"] or l["protection_qty"] == 0):
            extra = (l["recommended_qty"] - l["qty"]) * l["unit_cost"]
            if extra <= left + 1e-9:
                l["qty"], left = l["recommended_qty"], left - extra

    for rank, l in enumerate(order, 1):
        l["priority"] = rank
        l["line_cost"] = round(l["qty"] * l["unit_cost"], 2)
        l["status"] = "full" if l["qty"] == l["recommended_qty"] else "reduced" if l["qty"] else "deferred"
        after = l["position"] + l["qty"]
        l["cover_after_days"] = round(after / max(l["daily_forecast"], 1e-6), 1)
        l["reason"] = _reason(l)
        l.pop("value_density")

    spend = round(sum(l["line_cost"] for l in order), 2)
    unconstrained = round(sum(l["recommended_qty"] * l["unit_cost"] for l in order), 2)
    by_sup = {}
    for l in order:
        if l["qty"]:
            by_sup.setdefault(l["supplier_id"], 0.0)
            by_sup[l["supplier_id"]] += l["line_cost"]
    suppliers = [{"supplier_id": sid, "name": sup[sid]["name"], "subtotal": round(v, 2), "min_order_value": float(sup[sid]["min_order_value"]),
                  "meets_minimum": v >= float(sup[sid]["min_order_value"])} for sid, v in by_sup.items()]
    return {
        "method": "greedy-heuristic", "assumptions": ASSUMPTIONS, "service_level": sl, "z": round(z_for(sl), 3), "review_days": R,
        "lead_time_overrides": lto, "budget": float(budget), "spend": spend, "remaining": round(float(budget) - spend, 2),
        "utilisation": round(spend / float(budget), 4) if budget else None, "unconstrained_spend": unconstrained,
        "counts": {s: sum(1 for l in order if l["status"] == s) for s in ("full", "reduced", "deferred")},
        "suppliers": suppliers, "lines": order,
    }


def _reason(l: dict) -> str:
    if l["tier"] == 0:
        head = f"Runs out in {l['cover_days']:.1f} days; a new delivery takes {l['lead_time_days']:.0f}."
    elif l["tier"] == 1:
        head = f"Covers {l['cover_days']:.1f} days, less than lead time plus the {l['review_days']}-day review."
    else:
        head = "Below its reorder point at this review."
    if l["status"] == "full":
        tail = "Fully funded, including safety stock."
    elif l["status"] == "reduced":
        tail = f"Reduced to {l['qty']} to fit the budget: covers demand to the next review delivery, no safety stock."
    elif l["protection_qty"] == 0:
        tail = "Deferred for budget: only the safety buffer is missing, expected demand is covered."
    else:
        tail = f"Deferred for budget: about {l['shortfall_units_if_deferred']:.0f} units short before the next review delivery."
    return f"{head} {tail}"
