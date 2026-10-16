"""Single tool registry: the same functions power the agent, the REST API and (later) an MCP server.

NOTE: there is intentionally NO approve/reject tool here. The agent can only create pending drafts.
"""
from __future__ import annotations

from app import config, store
from app.service import get_engine

TOOLS = [
    {"name": "get_portfolio_overview", "description": "Dataset overview: SKU count, suppliers, history length, inventory value, as-of date.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "forecast_demand",
     "description": "Statistical demand forecast for ONE SKU (auto-selects best of seasonal-naive / moving-average / exp-smoothing by backtest WAPE). Returns method, WAPE, forecast and interval.",
     "parameters": {"type": "object", "properties": {"sku": {"type": "string"}, "horizon_days": {"type": "integer", "default": 28}}, "required": ["sku"]}},
    {"name": "detect_inventory_risk",
     "description": "Rank SKUs by inventory risk: STOCKOUT_RISK, EXCESS_STOCK, SLOW_MOVING, EXPIRY_RISK. Returns the top N with score, reason codes, days of cover and value at risk.",
     "parameters": {"type": "object", "properties": {"top_n": {"type": "integer", "default": 10}}}},
    {"name": "optimize_replenishment",
     "description": "Compute reorder points, safety stock and order quantities and return per-supplier PO drafts with estimated cost. Does NOT save anything.",
     "parameters": {"type": "object", "properties": {"service_level": {"type": "number", "default": 0.95}, "review_days": {"type": "integer", "default": 7}, "supplier_id": {"type": "string"}}}},
    {"name": "create_purchase_order_drafts",
     "description": "Save the current PO drafts into the approval queue with status 'pending'. A human must approve them; you cannot.",
     "parameters": {"type": "object", "properties": {"supplier_id": {"type": "string"}, "rationale": {"type": "string"}, "service_level": {"type": "number"}, "review_days": {"type": "integer"}}}},
]


def _compact_replenish(res: dict, max_lines: int = 6) -> dict:
    """Trim for LLM context; the full data remains available via the REST API."""
    out = {k: v for k, v in res.items() if k != "drafts"}
    out["drafts"] = [{**{k: v for k, v in d.items() if k != "lines"}, "line_count": len(d["lines"]), "top_lines": d["lines"][:max_lines]}
                     for d in res["drafts"]]
    return out


def call_tool(name: str, args: dict | None = None, compact: bool = False) -> dict:
    a = args or {}
    e = get_engine()
    if name == "get_portfolio_overview":
        return e.overview()
    if name == "forecast_demand":
        return e.forecast_summary(a["sku"], a.get("horizon_days", 28))
    if name == "detect_inventory_risk":
        return e.risk(a.get("top_n", 10))
    if name == "optimize_replenishment":
        r = e.replenish(a.get("service_level"), a.get("review_days"), a.get("supplier_id"))
        return _compact_replenish(r) if compact else r
    if name == "create_purchase_order_drafts":
        r = e.replenish(a.get("service_level"), a.get("review_days"), a.get("supplier_id"))
        pos = store.create_pending(r["drafts"], rationale=a.get("rationale", ""), created_by="agent")
        return {"created": [{"id": p["id"], "supplier": p["supplier_name"], "total_cost": p["total_cost"], "status": p["status"], "lines": len(p["lines"])} for p in pos],
                "note": "Saved as PENDING. A human approver must approve before anything is ordered."}
    raise KeyError(f"Unknown tool {name}")


def openai_tool_schema() -> list[dict]:
    return [{"type": "function", "function": t} for t in TOOLS]
