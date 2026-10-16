"""Tool 2 - inventory risk detection (rules + score, fully deterministic)."""
from __future__ import annotations

import math
from datetime import date

import pandas as pd

from app.config import EXCESS_COVER_DAYS

SLOW_PERCENTILE = 0.20  # bottom 20% by daily units = slow-moving candidates


def assess(inv: pd.DataFrame, daily: dict, sup: pd.DataFrame, today: date, excess_days: float = EXCESS_COVER_DAYS) -> pd.DataFrame:
    """inv: inventory rows; daily: sku -> forecast mean daily demand. Returns a ranked frame."""
    lt = sup.set_index("supplier_id")["lead_time_days"].to_dict()
    vel_cut = pd.Series({s: daily.get(s, 0.0) for s in inv["sku"]}).quantile(SLOW_PERCENTILE)
    rows = []
    for r in inv.itertuples():
        d = max(float(daily.get(r.sku, 0.0)), 1e-6)
        pos = float(r.stock + r.on_order)
        cover_stock = r.stock / d
        cover_pos = pos / d
        L = float(lt.get(r.supplier_id, 7))
        reasons, score, value_at_risk = [], 0.0, 0.0

        if cover_pos < L:  # position cannot bridge the lead time
            sev = min(1.0, (L - cover_pos) / L)
            s = 60 + 40 * sev
            reasons.append(("STOCKOUT_RISK", s))
            value_at_risk = max(value_at_risk, d * (L - cover_pos) * r.unit_price)
        if cover_pos > excess_days:
            sev = min(1.0, (cover_pos - excess_days) / (2 * excess_days))
            reasons.append(("EXCESS_STOCK", 20 + 30 * sev))
            value_at_risk = max(value_at_risk, (cover_pos - excess_days) * d * r.unit_cost)
        if d <= vel_cut and cover_pos > 60:
            reasons.append(("SLOW_MOVING", 15 + min(10.0, cover_pos / 60)))
        exp = r.earliest_expiry_date
        days_to_exp = None
        if isinstance(exp, str) and exp:
            days_to_exp = (date.fromisoformat(exp) - today).days
            unsold = r.stock - d * max(days_to_exp, 0)
            if unsold > 0:
                frac = min(1.0, unsold / max(r.stock, 1))
                reasons.append(("EXPIRY_RISK", 50 + 50 * frac))
                value_at_risk = max(value_at_risk, unsold * r.unit_cost)
        if reasons:
            reasons.sort(key=lambda x: -x[1])
            score = reasons[0][1]
        rows.append(dict(
            sku=r.sku, name=r.name, supplier_id=r.supplier_id, stock=int(r.stock), on_order=int(r.on_order),
            daily_forecast=round(d, 2), days_cover=round(cover_stock, 1), days_cover_incl_pipeline=round(cover_pos, 1),
            lead_time_days=L, days_to_expiry=days_to_exp, risk_score=round(score, 1),
            primary_reason=reasons[0][0] if reasons else "OK", all_reasons=[x[0] for x in reasons],
            value_at_risk=round(value_at_risk, 2),
        ))
    return pd.DataFrame(rows).sort_values(["risk_score", "value_at_risk"], ascending=False).reset_index(drop=True)
