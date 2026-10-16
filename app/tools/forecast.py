"""Tool 1 - demand forecasting. Pure numpy, deterministic, explainable.

Candidates (daily series, weekly seasonality):
  seasonal_naive   mean of the last 4 same-weekday values
  moving_average   flat mean of the last 28 days
  ses_seasonal     weekday-index x simple exponential smoothing level
  holt_seasonal    weekday-index x damped-trend exponential smoothing
The winner is chosen by WAPE on a rolling-origin holdout. The LLM never touches these numbers.
"""
from __future__ import annotations

import numpy as np

PERIOD = 7
HOLDOUT = 28


def _season_idx(y: np.ndarray, window: int = 56) -> np.ndarray:
    """Multiplicative weekday factors indexed by absolute position mod 7 (mean = 1)."""
    n = len(y)
    if n < 2 * PERIOD:
        return np.ones(PERIOD)
    start = max(0, n - window)
    pos = np.arange(start, n)
    seg = y[start:]
    overall = seg.mean()
    if overall <= 0:
        return np.ones(PERIOD)
    f = np.array([seg[pos % PERIOD == p].mean() / overall if np.any(pos % PERIOD == p) else 1.0 for p in range(PERIOD)])
    return f / f.mean()


def _fc_seasonal_naive(y, h):
    n = len(y)
    out = np.empty(h)
    for i in range(h):
        p = (n + i) % PERIOD
        idx = [j for j in range(n - 28, n) if j >= 0 and j % PERIOD == p]
        out[i] = np.mean(y[idx]) if idx else y[-28:].mean()
    return out


def _fc_moving_average(y, h):
    return np.full(h, y[-28:].mean())


def _smooth(z, alphas, betas=(None,), phi=0.9):
    """Grid-search ES parameters by one-step SSE; return the final (level, trend)."""
    best = None
    for a in alphas:
        for b in betas:
            lvl = z[:7].mean()
            tr = 0.0
            sse = 0.0
            for v in z:
                pred = lvl + (phi * tr if b is not None else 0.0)
                sse += (v - pred) ** 2
                new_lvl = a * v + (1 - a) * pred
                if b is not None:
                    tr = b * (new_lvl - lvl) + (1 - b) * phi * tr
                lvl = new_lvl
            if best is None or sse < best[0]:
                best = (sse, lvl, tr, b)
    return best[1], best[2], best[3]


def _fc_ses(y, h):
    s = _season_idx(y)
    z = y / s[np.arange(len(y)) % PERIOD].clip(0.2)
    lvl, _, _ = _smooth(z, alphas=(0.05, 0.1, 0.2, 0.3, 0.5))
    return np.array([lvl * s[(len(y) + i) % PERIOD] for i in range(h)])


def _fc_holt(y, h, phi=0.9):
    s = _season_idx(y)
    z = y / s[np.arange(len(y)) % PERIOD].clip(0.2)
    lvl, tr, _ = _smooth(z, alphas=(0.1, 0.2, 0.3), betas=(0.05, 0.1, 0.2), phi=phi)
    out = np.empty(h)
    damp = 0.0
    for i in range(h):
        damp += phi ** (i + 1)
        out[i] = (lvl + damp * tr) * s[(len(y) + i) % PERIOD]
    return out


METHODS = {
    "seasonal_naive": _fc_seasonal_naive,
    "moving_average": _fc_moving_average,
    "ses_seasonal": _fc_ses,
    "holt_seasonal": _fc_holt,
}


def wape(actual: np.ndarray, fc: np.ndarray) -> float:
    d = float(np.abs(actual).sum())
    return float(np.abs(actual - fc).sum() / d) if d > 0 else 1.0


def forecast_series(y, horizon: int = 56, holdout: int = HOLDOUT, method: str | None = None) -> dict:
    """Forecast one SKU. `y` is the daily units series (oldest first)."""
    y = np.asarray(y, dtype=float)
    if len(y) < 21 or y.sum() <= 0:
        mu = float(y.mean()) if len(y) else 0.0
        return dict(method="insufficient_history", wape=1.0, candidates={}, forecast=np.full(horizon, mu),
                    sigma_daily=float(y.std()) if len(y) > 1 else 0.0, mean_daily=mu, history_days=len(y))
    hold = min(holdout, max(7, len(y) // 4))
    train, test = y[:-hold], y[-hold:]
    cands, resid = {}, {}
    for name, fn in METHODS.items():
        try:
            f = np.clip(fn(train, hold), 0, None)
            cands[name] = round(wape(test, f), 4)
            resid[name] = test - f
        except Exception:  # a failing candidate must never break the tool
            continue
    best = method or min(cands, key=cands.get)
    fc = np.clip(METHODS[best](y, horizon), 0, None)
    sigma = float(np.std(resid[best])) if best in resid else float(y[-28:].std())
    return dict(method=best, wape=cands.get(best, 1.0), candidates=cands, forecast=fc,
                sigma_daily=sigma, mean_daily=float(fc[:28].mean()), history_days=len(y))


def summarize(sku: str, r: dict, horizon: int) -> dict:
    """JSON-safe, LLM-friendly summary of a forecast result."""
    fc = r["forecast"][:horizon]
    s = r["sigma_daily"]
    return {
        "sku": sku,
        "method": r["method"],
        "backtest_wape": round(r["wape"], 3),
        "candidate_wape": r["candidates"],
        "history_days": r["history_days"],
        "horizon_days": int(horizon),
        "forecast_total_units": round(float(fc.sum()), 1),
        "forecast_mean_daily": round(float(fc.mean()), 2),
        "next_7_days": [round(float(v), 1) for v in fc[:7]],
        "interval_80pct_daily": [round(max(0.0, float(fc.mean()) - 1.28 * s), 2), round(float(fc.mean()) + 1.28 * s, 2)],
        "sigma_daily": round(s, 2),
    }
