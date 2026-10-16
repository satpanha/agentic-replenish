"""Replay the last N days as if the system had been live, and compare policies.

Policies
  agentic : forecast (auto-selected statistical model) + safety stock + (s,S) with pack/MOQ rounding, reviewed weekly
  static  : what many small retailers do - a fixed min/max set once from the pre-test average demand (+20% buffer),
            order-up-to 30 days of that average. No forecast, no safety stock logic.
Demand = recorded sales (lost sales are not observed in the sample, so this is a conservative replay).
Run:  python -m backtest.run_backtest [--days 84] [--service-level 0.95]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from app.service import Engine
from app.tools.forecast import forecast_series, wape
from app.tools.replenish import decide_order

HOLD_RATE = 0.25  # annual holding cost as a share of unit cost


def simulate(y, t0, L, lt_std, R, pack, moq, cost, price, policy, sl, shelf):
    stock = float(round(y[max(0, t0 - 28):t0].mean() * 14))
    pipeline, lost, sold, stock_hist, orders, fc_err = [], 0.0, 0.0, [], 0, []
    static_min = static_max = None
    if policy == "static":
        base = y[:t0][-90:].mean()
        static_min, static_max = base * L * 1.2, base * 30
    for t in range(t0, len(y)):
        stock += sum(q for a, q in pipeline if a == t)
        pipeline = [(a, q) for a, q in pipeline if a > t]
        if (t - t0) % R == 0:
            pos = stock + sum(q for _, q in pipeline)
            hist = y[:t]
            if policy == "agentic":
                f = forecast_series(hist, L + R + 7)
                d = decide_order(f["forecast"], f["sigma_daily"], L, lt_std, R, sl, pos, pack, moq, 0.8 * shelf if shelf else None)
                qty = d["order_qty"]
                fc_err.append((y[t:t + R], f["forecast"][:len(y[t:t + R])]))
            else:
                qty = 0
                if pos <= static_min:
                    qty = int(math.ceil((static_max - pos) / pack) * pack)
                    qty = max(qty, moq)
                m = np.full(len(y[t:t + R]), hist[-28:].mean())
                fc_err.append((y[t:t + R], m))
            if qty > 0:
                pipeline.append((t + int(math.ceil(L)), qty))
                orders += 1
        dem = float(y[t])
        s = min(stock, dem)
        sold += s
        lost += dem - s
        stock -= s
        stock_hist.append(stock)
    days = len(y) - t0
    avg_inv = float(np.mean(stock_hist))
    hold = avg_inv * cost * HOLD_RATE / 365 * days
    lost_margin = lost * (price - cost)
    a = np.concatenate([x for x, _ in fc_err]); f_ = np.concatenate([f for _, f in fc_err])
    return dict(demand=float(sold + lost), lost_units=float(lost), avg_inventory_units=avg_inv, avg_inventory_value=avg_inv * cost,
                holding_cost=hold, lost_margin=lost_margin, orders=orders, stockout_days=int(sum(1 for s in stock_hist if s <= 0)),
                wape_num=float(np.abs(a - f_).sum()), wape_den=float(np.abs(a).sum()))


def run(days: int = 84, service_level: float = 0.95, review: int = 7, out: Path | None = None) -> dict:
    e = Engine()
    sup = e.sup.set_index("supplier_id").to_dict("index")
    tot = {p: {} for p in ("agentic", "static")}
    for r in e.inv.itertuples():
        y = e.series[r.sku]
        t0 = len(y) - days
        s = sup[r.supplier_id]
        shelf = float(r.shelf_life_days) if str(r.shelf_life_days) not in ("", "nan") else None
        for p in tot:
            res = simulate(y, t0, s["lead_time_days"], s["lead_time_std_days"], review, int(r.pack_size), int(r.moq),
                           float(r.unit_cost), float(r.unit_price), p, service_level, shelf)
            for k, v in res.items():
                tot[p][k] = tot[p].get(k, 0.0) + v
    summary = {}
    for p, t in tot.items():
        total_cost = t["holding_cost"] + t["lost_margin"]
        summary[p] = dict(
            fill_rate=round(1 - t["lost_units"] / t["demand"], 4), lost_units=round(t["lost_units"]),
            stockout_sku_days=t["stockout_days"], avg_inventory_value=round(t["avg_inventory_value"], 2),
            holding_cost=round(t["holding_cost"], 2), lost_margin=round(t["lost_margin"], 2),
            total_cost=round(total_cost, 2), orders=int(t["orders"]), next_week_wape=round(t["wape_num"] / t["wape_den"], 4))
    a, b = summary["agentic"], summary["static"]
    delta = dict(
        stockout_units_avoided=b["lost_units"] - a["lost_units"],
        stockout_reduction_pct=round(100 * (b["lost_units"] - a["lost_units"]) / max(b["lost_units"], 1), 1),
        inventory_value_change_pct=round(100 * (a["avg_inventory_value"] - b["avg_inventory_value"]) / max(b["avg_inventory_value"], 1), 1),
        lost_margin_recovered=round(b["lost_margin"] - a["lost_margin"], 2),
        net_cost_saving=round(b["total_cost"] - a["total_cost"], 2),
        net_cost_saving_pct=round(100 * (b["total_cost"] - a["total_cost"]) / max(b["total_cost"], 1), 1),
        fill_rate_gain_pts=round(100 * (a["fill_rate"] - b["fill_rate"]), 2),
        forecast_wape_improvement_pts=round(100 * (b["next_week_wape"] - a["next_week_wape"]), 2))
    result = dict(config=dict(days=days, service_level=service_level, review_days=review, skus=len(e.inv), holding_rate=HOLD_RATE,
                              caveat="Synthetic sample data; sales used as demand (no censoring). Re-run on real data before quoting."),
                  agentic=a, static=b, delta=delta)
    out = out or Path(__file__).parent / "results.json"
    out.write_text(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=84)
    ap.add_argument("--service-level", type=float, default=0.95)
    a = ap.parse_args()
    r = run(a.days, a.service_level)
    print(json.dumps(r, indent=2))
