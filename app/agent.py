"""Orchestrator agent.

* LLM mode  : OpenAI-compatible tool-calling loop against AMD Token Factory (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).
* Offline   : deterministic pipeline + templated explanation, so the demo never breaks if the endpoint is down.
The LLM plans, explains and writes the PO rationale. All numbers come from the tools.
"""
from __future__ import annotations

import json
import time

from app import config
from app.registry import call_tool, openai_tool_schema

SYSTEM_PROMPT = """You are an inventory planning copilot for a retailer. You have tools for demand forecasting, inventory risk detection and replenishment.
Rules:
1. Never invent or compute numbers yourself. Every figure you state must come from a tool result.
2. For a full review: call detect_inventory_risk, then forecast_demand for the 2-3 most at-risk SKUs, then optimize_replenishment, then create_purchase_order_drafts.
3. When you explain a forecast, always state the method used and its backtest WAPE (lower is better).
4. Purchase orders are only ever saved as PENDING. State clearly that a human must approve them. You cannot approve.
5. Final answer: short and decision-oriented. Sections: Attention first (top risks with reason + value at risk), Forecast evidence, Proposed purchase orders (supplier, lines, cost), Next step for the human."""

MAX_STEPS = 8


def _client():
    from openai import OpenAI
    return OpenAI(base_url=config.LLM_BASE_URL, api_key=config.LLM_API_KEY, timeout=60)


def run_agent(goal: str | None = None, create_drafts: bool = True) -> dict:
    goal = goal or "Run a full inventory review: find the products that need attention, explain the forecast evidence, and draft purchase orders for approval."
    if not config.LLM_ENABLED:
        return _offline(goal, create_drafts, note="LLM_* env vars not set - running offline deterministic mode.")
    try:
        return _llm_loop(goal, create_drafts)
    except Exception as ex:  # endpoint down / auth error: degrade gracefully, keep the demo alive
        return _offline(goal, create_drafts, note=f"LLM call failed ({type(ex).__name__}: {str(ex)[:160]}). Fell back to offline mode.")


def _llm_loop(goal: str, create_drafts: bool) -> dict:
    client = _client()
    tools = openai_tool_schema()
    if not create_drafts:
        tools = [t for t in tools if t["function"]["name"] != "create_purchase_order_drafts"]
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": goal}]
    trace, created, t0 = [], [], time.time()
    for step in range(MAX_STEPS):
        resp = client.chat.completions.create(model=config.LLM_MODEL, messages=msgs, tools=tools, tool_choice="auto", temperature=0.2)
        m = resp.choices[0].message
        if not m.tool_calls:
            return {"mode": "llm", "model": config.LLM_MODEL, "answer": m.content or "", "trace": trace, "purchase_orders": created,
                    "seconds": round(time.time() - t0, 1)}
        msgs.append({"role": "assistant", "content": m.content or "", "tool_calls": [
            {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}} for c in m.tool_calls]})
        for c in m.tool_calls:
            try:
                args = json.loads(c.function.arguments or "{}")
                res = call_tool(c.function.name, args, compact=True)
                if c.function.name == "create_purchase_order_drafts":
                    created = res["created"]
            except Exception as ex:
                args, res = {}, {"error": f"{type(ex).__name__}: {ex}"}
            trace.append({"step": step + 1, "tool": c.function.name, "args": args, "result_preview": _preview(res)})
            msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(res, default=str)})
    return {"mode": "llm", "model": config.LLM_MODEL, "answer": "Stopped after the maximum number of tool steps.", "trace": trace,
            "purchase_orders": created, "seconds": round(time.time() - t0, 1)}


def _preview(res: dict, n: int = 400) -> str:
    s = json.dumps(res, default=str)
    return s if len(s) <= n else s[:n] + "..."


def _offline(goal: str, create_drafts: bool, note: str) -> dict:
    trace, t0 = [], time.time()

    def step(tool, args=None):
        r = call_tool(tool, args or {}, compact=True)
        trace.append({"step": len(trace) + 1, "tool": tool, "args": args or {}, "result_preview": _preview(r)})
        return r

    risk = step("detect_inventory_risk", {"top_n": 5})
    fcs = [step("forecast_demand", {"sku": r["sku"]}) for r in risk["top"][:3]]
    rep = step("optimize_replenishment")
    created = []
    if create_drafts and rep["drafts"]:
        created = step("create_purchase_order_drafts", {"rationale": "Offline deterministic review"})["created"]

    L = [f"{note}", "", "Attention first:"]
    for r in risk["top"]:
        L.append(f"- {r['name']} ({r['sku']}): {r['primary_reason']}, score {r['risk_score']}, cover {r['days_cover']}d vs lead time {r['lead_time_days']:.0f}d, value at risk {r['value_at_risk']:,.0f}.")
    L += ["", "Forecast evidence:"]
    for f in fcs:
        L.append(f"- {f['sku']}: {f['method']} (backtest WAPE {f['backtest_wape']}), ~{f['forecast_mean_daily']} units/day.")
    L += ["", f"Proposed purchase orders: {len(rep['drafts'])} suppliers, {rep['line_count']} lines, estimated cost {rep['total_cost']:,.2f}."]
    for d in rep["drafts"]:
        L.append(f"- {d['supplier_name']}: {d['line_count']} lines, {d['total_cost']:,.2f}" + (f" (warning: {d['warnings'][0]})" if d["warnings"] else ""))
    L += ["", "Next step: a human approver must review and approve these pending purchase orders. Nothing has been ordered."]
    return {"mode": "offline", "model": None, "answer": "\n".join(L), "trace": trace, "purchase_orders": created, "seconds": round(time.time() - t0, 1)}
