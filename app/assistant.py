"""Procurement assistant: answers decision questions from the engine's own numbers.

The answer is built deterministically: an intent router picks the calculation (risk, order policy,
budget optimizer, lead-time what-if), runs it, and writes the facts. When an LLM is configured it
may rephrase the answer from those facts only; facts, links and numbers are returned unchanged
alongside, and `tools_run` lists exactly the functions that executed.
"""
from __future__ import annotations

import json
import re

from app import config
from app.tools.budget import optimize

SUGGESTIONS = [
    "Why is {sku} at risk?",
    "Why this reorder quantity for {sku}?",
    "What happens if my weekly budget decreases by 15%?",
    "What happens if {supplier} adds 5 days to the lead time?",
    "Which products can be prioritized within the current budget?",
]


def _money(v: float) -> str:
    return f"${v:,.0f}" if abs(v) >= 100 else f"${v:,.2f}"


def _find_sku(e, q: str, ctx_sku: str | None):
    ql = q.lower()
    m = re.search(r"\bsku\d{3,}\b", ql)
    if m and m.group(0).upper() in e.series:
        return m.group(0).upper()
    best = None
    for r in e.inv.itertuples():
        name = r.name.lower()
        head = name.split()[0]
        if name in ql or (len(head) > 3 and re.search(rf"\b{re.escape(head)}\b", ql)):
            if best is None or len(name) > len(best[1]):
                best = (r.sku, name)
    return best[0] if best else ctx_sku


def _find_supplier(e, q: str, sku: str | None):
    ql = q.lower()
    for r in e.sup.itertuples():
        words = [w for w in r.name.lower().split() if len(w) > 3 and w not in ("supply", "foods", "import", "care")]
        if r.name.lower() in ql or any(re.search(rf"\b{re.escape(w)}\b", ql) for w in words):
            return r.supplier_id
    if sku:
        return e.inv.set_index("sku").loc[sku, "supplier_id"]
    return None


def answer(e, question: str, sku: str | None = None, budget: float | None = None, service_level: float | None = None) -> dict:
    q = (question or "").strip()
    ql = q.lower()
    budget = float(budget or 12000)
    target = _find_sku(e, q, sku)
    tools: list[str] = []
    facts: list[dict] = []
    links: list[dict] = []

    def fact(label, value, source="calc"):
        facts.append({"label": label, "value": value, "source": source})

    pct = re.search(r"(\d+(?:\.\d+)?)\s*%", ql)
    days = re.search(r"(\d+)\s*(?:more\s+)?days?", ql)

    if "budget" in ql and (pct or re.search(r"\$\s?[\d,]+", ql)):
        if pct:
            p = float(pct.group(1)) / 100
            new = budget * (1 - p if re.search(r"decreas|cut|reduc|lower|less|drop", ql) else 1 + p)
        else:
            new = float(re.search(r"\$\s?([\d,]+)", ql).group(1).replace(",", ""))
        base, sim = optimize(e, budget, service_level), optimize(e, new, service_level)
        tools += [f"optimize(budget={budget:.0f})", f"optimize(budget={new:.0f})"]
        before = {l["sku"]: l for l in base["lines"]}
        changed = [l for l in sim["lines"] if l["qty"] != before[l["sku"]]["qty"]]
        text = [f"With a weekly budget of {_money(new)} instead of {_money(budget)}, the optimizer spends {_money(sim['spend'])} "
                f"(was {_money(base['spend'])}): {sim['counts']['full']} lines fully funded, {sim['counts']['reduced']} reduced, {sim['counts']['deferred']} deferred."]
        for l in changed[:6]:
            b = before[l["sku"]]
            if l["status"] == "deferred":
                text.append(f"{l['name']} is deferred ({b['qty']} → 0): about {l['shortfall_units_if_deferred']:.0f} units short before the next review delivery, {_money(l['margin_at_risk_if_deferred'])} gross margin at risk.")
            else:
                text.append(f"{l['name']} goes {b['qty']} → {l['qty']} ({l['status']}).")
            links.append({"kind": "sku", "id": l["sku"], "label": l["name"]})
        if not changed:
            text.append("No order line changes: every line still fits.")
        protected = [l["name"] for l in sim["lines"] if l["tier"] == 0 and l["qty"]]
        if protected:
            text.append(f"Still protected from running out before delivery: {', '.join(protected)}.")
        fact("Budget", f"{_money(budget)} → {_money(new)}")
        fact("Proposed spend", f"{_money(base['spend'])} → {_money(sim['spend'])}")
        fact("Deferred lines", f"{base['counts']['deferred']} → {sim['counts']['deferred']}")
        links.append({"kind": "cart", "id": "", "label": "Open the what-if simulator"})
        intent = "budget_change"

    elif re.search(r"lead.?time|delay|late|adds?\s+\d+\s+days?", ql) and days:
        sid = _find_supplier(e, q, target)
        if not sid:
            return _unsure(q, "Which supplier? Name one, for example “Siam Snacks Import adds 5 days”.")
        add = int(days.group(1))
        s = e.sup.set_index("supplier_id").loc[sid]
        new_lt = float(s["lead_time_days"]) + add
        base, sim = optimize(e, budget, service_level), optimize(e, budget, service_level, lead_time_overrides={sid: new_lt})
        tools += [f"optimize(budget={budget:.0f})", f"optimize(budget={budget:.0f}, lead_time[{sid}]={new_lt:.0f})"]
        risk = e.risk_frame()
        mine = risk[risk.supplier_id == sid]
        newly = mine[(mine.days_cover_incl_pipeline >= mine.lead_time_days) & (mine.days_cover_incl_pipeline < new_lt)]
        already = mine[mine.days_cover_incl_pipeline < mine.lead_time_days]
        tools.append("risk_frame()")
        before = {l["sku"]: l for l in base["lines"]}
        text = [f"If {s['name']} takes {new_lt:.0f} days instead of {s['lead_time_days']:.0f}:"]
        if len(newly):
            text.append(f"{len(newly)} more product{'s' if len(newly) > 1 else ''} would run out before a new delivery: {', '.join(newly.name)}.")
        if len(already):
            text.append(f"{', '.join(already.name)} already run{'s' if len(already) == 1 else ''} out before delivery; the gap grows by {add} days each.")
        for l in sim["lines"]:
            if l["supplier_id"] == sid:
                b = before.get(l["sku"])
                text.append(f"{l['name']}: order {b['qty'] if b else 0} → {l['qty']} units ({_money(l['line_cost'])}).")
                links.append({"kind": "sku", "id": l["sku"], "label": l["name"]})
        text.append(f"Total proposed spend {_money(base['spend'])} → {_money(sim['spend'])} at a {_money(budget)} budget.")
        fact("Lead time", f"{s['lead_time_days']:.0f} → {new_lt:.0f} days")
        fact("Newly at risk", str(len(newly)))
        fact("Proposed spend", f"{_money(base['spend'])} → {_money(sim['spend'])}")
        intent = "lead_time_change"

    elif re.search(r"prioriti|which products|what (should|can) i (buy|order)|within (the |my )?(current )?budget", ql):
        r = optimize(e, budget, service_level)
        tools.append(f"optimize(budget={budget:.0f})")
        text = [f"At {_money(budget)} the optimizer funds {r['counts']['full'] + r['counts']['reduced']} of {len(r['lines'])} lines for {_money(r['spend'])} ({(r['utilisation'] or 0) * 100:.0f}% of budget). In priority order:"]
        for l in r["lines"][:8]:
            text.append(f"{l['priority']}. {l['name']}: {l['qty']} units, {_money(l['line_cost'])}, {l['status']}. {l['reason']}")
            links.append({"kind": "sku", "id": l["sku"], "label": l["name"]})
        fact("Funded lines", f"{r['counts']['full']} full, {r['counts']['reduced']} reduced")
        fact("Deferred", str(r["counts"]["deferred"]))
        fact("Remaining budget", _money(r["remaining"]))
        intent = "prioritize"

    elif target and re.search(r"quantit|how (much|many)|qty|why (this|that) (order|amount|number)|reorder", ql):
        r = optimize(e, budget, service_level)
        tools.append(f"optimize(budget={budget:.0f})")
        l = next((x for x in r["lines"] if x["sku"] == target), None)
        name = e.inv.set_index("sku").loc[target, "name"]
        links.append({"kind": "sku", "id": target, "label": name})
        if not l:
            rk = e.risk_frame().set_index("sku").loc[target]
            tools.append("risk_frame()")
            text = [f"{name} has no order this cycle: stock and open orders cover {rk.days_cover_incl_pipeline:.1f} days, above the reorder point for its {rk.lead_time_days:.0f}-day lead time."]
        else:
            text = [f"{name}: the policy orders up to {l['order_up_to']:.0f} units, which is forecast demand over the {l['lead_time_days']:.0f}-day lead time "
                    f"({l['demand_over_lead_time']:.0f}) plus the {l['review_days']}-day review period ({l['demand_over_review']:.0f}) plus {l['safety_stock']:.0f} safety stock "
                    f"at a {r['service_level'] * 100:.0f}% service level.",
                    f"Stock plus open orders is {l['position']:.0f}, so {l['order_up_to'] - l['position']:.0f} are needed, rounded up to packs of {l['pack_size']} "
                    f"(MOQ {l['moq']}) = {l['recommended_qty']} units.",
                    f"At the {_money(budget)} budget it is {l['status']}: {l['qty']} units, {_money(l['line_cost'])}."]
            fact("Order-up-to level", f"{l['order_up_to']:.0f}")
            fact("Safety stock", f"{l['safety_stock']:.0f}")
            fact("Recommended", f"{l['recommended_qty']} units", "calc")
            links.append({"kind": "cart_line", "id": target, "label": "Review in cart"})
        intent = "why_quantity"

    elif target and re.search(r"risk|why|run out|stock.?out|short", ql):
        rk = e.risk_frame().set_index("sku").loc[target]
        f = e.forecast(target)
        tools += ["risk_frame()", f"forecast({target})"]
        name = rk["name"]
        links.append({"kind": "sku", "id": target, "label": name})
        reasons = rk.all_reasons
        text = []
        if "STOCKOUT_RISK" in reasons:
            text.append(f"{name} sells about {rk.daily_forecast:.1f} a day. Stock ({rk.stock}) plus open orders ({rk.on_order}) covers {rk.days_cover_incl_pipeline:.1f} days, "
                        f"but a new delivery takes {rk.lead_time_days:.0f} days, so the shelf is projected to be empty for about {rk.lead_time_days - rk.days_cover_incl_pipeline:.1f} days.")
        if "EXPIRY_RISK" in reasons:
            text.append(f"Its earliest batch expires in {int(rk.days_to_expiry)} days, before current stock can sell at the forecast rate.")
        if "EXCESS_STOCK" in reasons:
            text.append(f"It holds {rk.days_cover_incl_pipeline:.0f} days of cover, above the {config.EXCESS_COVER_DAYS:.0f}-day excess threshold.")
        if "SLOW_MOVING" in reasons:
            text.append("It is in the slowest-selling 20% of products.")
        if not reasons:
            text.append(f"{name} is not flagged: {rk.days_cover_incl_pipeline:.1f} days of cover against a {rk.lead_time_days:.0f}-day lead time.")
        text.append(f"The forecast is a {f['method'].replace('_', ' ')} model with {f['wape'] * 100:.1f}% holdout error (WAPE); risk rules are fixed thresholds, not model judgement.")
        fact("Days of supply", f"{rk.days_cover_incl_pipeline:.1f}")
        fact("Lead time", f"{rk.lead_time_days:.0f} days")
        fact("Forecast", f"{rk.daily_forecast:.1f}/day", "forecast")
        fact("Risk score", f"{rk.risk_score:.0f}")
        intent = "why_risk"
    else:
        return _unsure(q, "I can answer: why a SKU is at risk, why it has its reorder quantity, what a budget change does, what a supplier delay does, and what to prioritize within budget.")

    out = {"intent": intent, "answer": "\n".join(text), "facts": facts, "links": links, "tools_run": tools,
           "mode": "deterministic", "model": None, "sku": target}
    if config.LLM_ENABLED:
        out = _rephrase(out, q)
    return out


def _unsure(q: str, msg: str) -> dict:
    return {"intent": "unknown", "answer": msg, "facts": [], "links": [], "tools_run": [], "mode": "deterministic", "model": None, "sku": None}


def _rephrase(out: dict, q: str) -> dict:
    """Let the model rewrite the deterministic answer in plain language. Numbers must be copied, not computed."""
    try:
        from app.agent import _client
        msg = [{"role": "system", "content": "Rewrite the DRAFT ANSWER for a busy retail buyer in at most 5 short sentences. "
                "Use only numbers that appear in the draft, copied exactly. Do not add facts, estimates or advice not in the draft."},
               {"role": "user", "content": f"QUESTION: {q}\nDRAFT ANSWER:\n{out['answer']}\nFACTS: {json.dumps(out['facts'])}"}]
        r = _client().chat.completions.create(model=config.LLM_MODEL, messages=msg, temperature=0.1)
        text = (r.choices[0].message.content or "").strip()
        nums = lambda t: set(re.findall(r"\d[\d,]*\.?\d*", t.replace(",", "")))
        if text and nums(text) <= nums(out["answer"] + json.dumps(out["facts"])):
            return {**out, "answer": text, "draft": out["answer"], "mode": "llm", "model": config.LLM_MODEL}
        return {**out, "note": "The model's wording introduced numbers not in the calculation, so the deterministic answer is shown."}
    except Exception as ex:  # keep the deterministic answer
        return {**out, "note": f"Model unavailable ({type(ex).__name__}); showing the deterministic answer."}
    return out
