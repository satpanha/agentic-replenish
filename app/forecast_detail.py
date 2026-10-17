"""Forecast workspace payload: history, forecast with interval, holdout evaluation and explanation factors.

Everything is computed from the same forecast tool the engine uses. Metrics are scored on the
holdout the model was selected on (the last 28 days), for the chosen model and for a 14-day SMA.
MAPE is only reported when it is meaningful: it is undefined on zero-demand days, so those days
are excluded and counted, and MAPE is withheld entirely when too many days are zero.
"""
from __future__ import annotations

import math
from datetime import timedelta

import numpy as np

from app.tools.forecast import HOLDOUT, METHODS, PERIOD, _season_idx, wape

Z80 = 1.2816
MAPE_MAX_ZERO_SHARE = 0.10
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _metrics(actual: np.ndarray, pred: np.ndarray) -> dict:
    err = actual - pred
    nz = actual > 0
    zero = int((~nz).sum())
    share = zero / len(actual) if len(actual) else 1.0
    mape, mape_note = None, None
    if not nz.any():
        mape_note = "Undefined: every holdout day had zero demand."
    elif share > MAPE_MAX_ZERO_SHARE:
        mape_note = f"Withheld: {zero} of {len(actual)} holdout days had zero demand, so percentage error would mislead."
    else:
        mape = float(np.mean(np.abs(err[nz]) / actual[nz]))
        if zero:
            mape_note = f"{zero} zero-demand day{'s' if zero > 1 else ''} excluded."
    return {
        "wape": round(wape(actual, pred), 4),
        "mae": round(float(np.mean(np.abs(err))), 2),
        "rmse": round(float(math.sqrt(np.mean(err ** 2))), 2),
        "bias": round(float(np.mean(pred - actual)), 2),
        "mape": None if mape is None else round(mape, 4),
        "mape_note": mape_note,
        "n": int(len(actual)),
    }


def build(e, sku: str, history_days: int = 56, horizon: int = 28) -> dict:
    if sku not in e.series:
        raise KeyError(f"Unknown SKU {sku}")
    y = np.asarray(e.series[sku], dtype=float)
    f = e.forecast(sku)
    horizon = max(1, min(int(horizon), len(f["forecast"])))
    history_days = max(14, min(int(history_days), len(y)))
    today = e.today
    start = today - timedelta(days=history_days)

    hold = min(HOLDOUT, max(7, len(y) // 4))
    train, test = y[:-hold], y[-hold:]
    method = f["method"]
    model_pred = np.clip(METHODS[method](train, hold), 0, None) if method in METHODS else np.full(hold, train.mean())
    sma_pred = np.full(hold, train[-14:].mean())

    fc = np.asarray(f["forecast"][:horizon])
    s = f["sigma_daily"]
    season = _season_idx(y)
    # weekday factor for calendar weekday w: positions p with (p % 7) map to dates; derive from today's position
    n = len(y)
    by_weekday = {}
    for p in range(PERIOD):
        date = today - timedelta(days=n - p)  # date of series position p (p = 0..6)
        by_weekday[date.weekday()] = float(season[p])
    v7, v28 = float(y[-7:].mean()), float(y[-28:].mean())
    prev28 = float(y[-56:-28].mean()) if n >= 56 else None
    last56 = y[-56:]
    inv = e.inv.set_index("sku").loc[sku]
    sup = e.sup.set_index("supplier_id").loc[inv.supplier_id]

    return {
        "sku": sku, "name": inv["name"], "category": inv["category"], "supplier_id": inv.supplier_id, "supplier_name": sup["name"],
        "as_of": today.isoformat(), "history_start": start.isoformat(),
        "history": [int(v) for v in y[-history_days:]],
        "forecast": [{"value": round(float(v), 1), "lo": round(max(0.0, float(v) - Z80 * s), 1), "hi": round(float(v) + Z80 * s, 1)} for v in fc],
        "sma14": round(float(y[-14:].mean()), 2),
        "model": {"method": method, "candidates": f["candidates"], "sigma_daily": round(s, 2), "interval": "80%"},
        "holdout": {
            "start": (today - timedelta(days=hold)).isoformat(), "days": hold,
            "actual": [int(v) for v in test], "model": [round(float(v), 1) for v in model_pred], "sma14": [round(float(v), 1) for v in sma_pred],
            "metrics": {"model": _metrics(test, model_pred), "sma14": _metrics(test, sma_pred)},
        },
        "factors": {
            "velocity_7d": round(v7, 2), "velocity_28d": round(v28, 2), "velocity_prev_28d": None if prev28 is None else round(prev28, 2),
            "trend_pct": None if not prev28 else round((v28 - prev28) / prev28, 4),
            "weekday_factors": [{"day": WEEKDAYS[w], "factor": round(by_weekday.get(w, 1.0), 3)} for w in range(7)],
            "cv_56d": round(float(last56.std() / last56.mean()), 3) if last56.mean() > 0 else None,
            "zero_days_56d": int((last56 == 0).sum()),
            "max_day_56d": int(last56.max()),
            "promotions_in_data": False,
            "lead_time_days": float(sup["lead_time_days"]), "lead_time_std_days": float(sup["lead_time_std_days"]),
            "forecast_total": round(float(fc.sum()), 1), "interval_total": [round(max(0.0, float(fc.sum()) - Z80 * s * math.sqrt(horizon)), 1), round(float(fc.sum()) + Z80 * s * math.sqrt(horizon), 1)],
            "history_days_available": int(n),
        },
        "source": "engine",
    }
