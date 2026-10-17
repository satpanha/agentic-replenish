"""FastAPI app: tool endpoints (plug-in surface), agent endpoint, approval queue, dashboard."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import assistant, config, dashboard, forecast_detail, ingest, store
from app.agent import run_agent
from app.registry import TOOLS, call_tool, openai_tool_schema
from app.service import get_engine, reload_engine
from app.tools.budget import optimize

app = FastAPI(title="Agentic Replenishment", version="0.1.0",
              description="Forecast -> risk -> replenishment tools, an LLM orchestrator, and a human-approval gate.")
FRONTEND = config.ROOT / "frontend"  # all browser files live here
BACKTEST_JSON = config.ROOT / "backtest" / "results.json"
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    if not (FRONTEND / "dist" / "main.js").exists():  # TypeScript not compiled yet
        return HTMLResponse("<p style='font:16px system-ui;padding:24px'>The frontend isn't built yet. Run <code>npm install</code> "
                            "then <code>npm run build</code> (or <code>npm run dev</code> to rebuild on save), and reload.</p>", status_code=503)
    return FileResponse(FRONTEND / "index.html")


@app.get("/console")
def console():
    """The original single-page console (agent run + approval queue), kept until Phase 2 replaces it."""
    return FileResponse(FRONTEND / "console.html")


@app.get("/api/health")
def health():
    e = get_engine()
    return {"ok": True, "llm_enabled": config.LLM_ENABLED, "model": config.LLM_MODEL or None,
            "data_source": "sample" if e.is_sample else "imported", "confirmed_updates": len(e.applied_updates)}


@app.get("/api/overview")
def overview():
    return call_tool("get_portfolio_overview")


# ---- plug-in surface: every tool is callable by any other system --------------------------
@app.get("/api/dashboard")
def dashboard_payload():
    return dashboard.build(get_engine())


@app.get("/api/forecast/{sku}")
def forecast_workspace(sku: str, history_days: int = 56, horizon: int = 28):
    try:
        return forecast_detail.build(get_engine(), sku, history_days, horizon)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/optimize")
def optimize_budget(body: dict = Body(default={})):
    budget = float(body.get("budget", 12000))
    if budget < 0:
        raise HTTPException(422, "Budget must be zero or more.")
    return optimize(get_engine(), budget, body.get("service_level"), body.get("review_days"), body.get("lead_time_overrides"))


@app.post("/api/assistant")
def ask(body: dict = Body(default={})):
    return assistant.answer(get_engine(), body.get("question", ""), body.get("sku"), body.get("budget"), body.get("service_level"))


@app.get("/api/tools")
def tools_list():
    return {"tools": TOOLS, "openai_schema": openai_tool_schema()}


@app.post("/api/tools/{name}")
def tool_call(name: str, args: dict = Body(default={})):
    try:
        return call_tool(name, args)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


@app.get("/api/risk")
def risk(top_n: int = 15):
    return call_tool("detect_inventory_risk", {"top_n": top_n})


# ---- agent ---------------------------------------------------------------------------------
@app.post("/api/agent/run")
def agent_run(body: dict = Body(default={})):
    return run_agent(body.get("goal"), body.get("create_drafts", True))


# ---- approval queue (human gate) -----------------------------------------------------------
def _auth(key: str | None):
    if key != config.APPROVER_KEY:
        raise HTTPException(401, "Approver key required (X-Approver-Key header).")


@app.get("/api/pos")
def pos(status: str | None = None):
    return {"purchase_orders": store.list_pos(status)}


@app.get("/api/pos/{po_id}")
def po_detail(po_id: int):
    try:
        return store.get_po(po_id)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/pos/drafts")
def po_drafts_from_cart(body: dict = Body(...)):
    """Create DRAFT purchase orders from the user's cart. Quantities are validated, never adjusted."""
    e = get_engine()
    inv = e.inv.set_index("sku")
    sup = e.sup.set_index("supplier_id")
    by_sup, errors = {}, []
    for ln in body.get("lines", []):
        sku, qty = ln.get("sku"), ln.get("qty")
        if sku not in inv.index:
            errors.append(f"Unknown SKU {sku}.")
            continue
        r = inv.loc[sku]
        if not isinstance(qty, int) or qty <= 0:
            errors.append(f"{r['name']}: quantity must be a positive whole number.")
            continue
        if qty % int(r.pack_size):
            errors.append(f"{r['name']}: {qty} is not a multiple of the case pack {int(r.pack_size)}.")
        if qty < int(r.moq):
            errors.append(f"{r['name']}: {qty} is below the minimum order quantity {int(r.moq)}.")
        by_sup.setdefault(r.supplier_id, []).append(dict(
            sku=sku, name=r["name"], qty=qty, unit_cost=float(r.unit_cost), line_cost=round(qty * float(r.unit_cost), 2),
            recommended_qty=ln.get("recommended_qty"), pack_size=int(r.pack_size), moq=int(r.moq)))
    if errors or not by_sup:
        raise HTTPException(422, " ".join(errors) or "The cart has no lines.")
    drafts = []
    for sid, lines in by_sup.items():
        s = sup.loc[sid]
        total = round(sum(l["line_cost"] for l in lines), 2)
        warn = [f"Total {total:,.2f} is below the supplier minimum order value {float(s.min_order_value):,.2f}."] if total < float(s.min_order_value) else []
        drafts.append(dict(supplier_id=sid, supplier_name=s["name"], lead_time_days=int(round(float(s.lead_time_days))),
                           lines=sorted(lines, key=lambda l: -l["line_cost"]), total_cost=total, warnings=warn))
    terms = {"currency": "USD", "budget": body.get("budget"), "service_level": config.SERVICE_LEVEL, "payment_terms": None}
    created = store.create_drafts(drafts, rationale=body.get("note", "Built in the Purchasing Cart"), created_by=body.get("by", "user"), terms=terms)
    return {"created": created}


@app.post("/api/pos/{po_id}/approve")
def approve(po_id: int, body: dict = Body(default={}), x_approver_key: str | None = Header(default=None), x_approver_name: str = Header(default="approver")):
    _auth(x_approver_key)
    try:
        return store.decide(po_id, True, x_approver_name, body.get("note", ""))
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/pos/{po_id}/reject")
def reject(po_id: int, body: dict = Body(default={}), x_approver_key: str | None = Header(default=None), x_approver_name: str = Header(default="approver")):
    _auth(x_approver_key)
    try:
        return store.decide(po_id, False, x_approver_name, body.get("note", ""))
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/pos/{po_id}/dispatch")
def po_dispatch(po_id: int, body: dict = Body(default={}), x_approver_key: str | None = Header(default=None),
                x_approver_name: str = Header(default="approver")):
    """Simulated dispatch through an integration point (demo). Never sends anything, never sets 'sent'."""
    _auth(x_approver_key)
    if body.get("mode", "simulated") != "simulated":
        raise HTTPException(501, "No supplier dispatch integration is connected; only simulated dispatch is available.")
    try:
        return store.simulate_dispatch(po_id, body.get("channel", "email"), x_approver_name)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/pos/{po_id}/{action}")
def po_transition(po_id: int, action: str, body: dict = Body(default={}), x_approver_key: str | None = Header(default=None),
                  x_approver_name: str = Header(default="approver")):
    """submit / return / mark_sent / acknowledge / cancel. Everything except submit needs the approver key."""
    if action not in ("submit", "return", "mark_sent", "acknowledge", "cancel"):
        raise HTTPException(404, f"Unknown action {action}")
    if action != "submit":
        _auth(x_approver_key)
    try:
        return store.transition(po_id, action, x_approver_name, body.get("note", ""))
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


# ---- confirmed supplier updates ---------------------------------------------------------
@app.get("/api/supplier-updates")
def supplier_updates(include_reverted: bool = False):
    return {"updates": store.list_updates(include_reverted)}


@app.post("/api/supplier-updates")
def confirm_supplier_updates(body: dict = Body(...)):
    """Confirm reviewed supplier-document values. They replace the CSV values in every calculation."""
    try:
        created = store.add_updates(body.get("updates", []), body.get("by", "reviewer"))
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))
    reload_engine()
    return {"confirmed": created}


@app.delete("/api/supplier-updates/{update_id}")
def revert_supplier_update(update_id: int):
    try:
        store.revert_update(update_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    reload_engine()
    return {"ok": True}


# ---- data import ------------------------------------------------------------------------
@app.get("/api/data/status")
def data_status():
    e = get_engine()
    return {"source": "sample" if e.is_sample else "imported", "skus": int(len(e.inv)), "suppliers": int(len(e.sup)),
            "history_days": int(len(next(iter(e.series.values())))), "as_of": e.today.isoformat()}


@app.post("/api/data/check")
def data_check(body: dict = Body(...)):
    res = ingest.validate(body.get("files", {}))
    res.pop("_frames", None)
    return res


@app.post("/api/data/import")
def data_import(body: dict = Body(...)):
    res = ingest.apply(body.get("files", {}))
    if not res["ok"]:
        raise HTTPException(422, " ".join(res["errors"]))
    reload_engine()
    return {**res, "status": data_status()}


@app.post("/api/data/reset")
def data_reset():
    ingest.reset_to_sample()
    reload_engine()
    return data_status()


@app.post("/api/demo/reset")
def demo_reset(x_approver_key: str | None = Header(default=None)):
    _auth(x_approver_key)
    store.reset()
    return {"ok": True}


@app.get("/api/backtest")
def backtest():
    if not BACKTEST_JSON.exists():
        return JSONResponse({"available": False, "hint": "Run: python -m backtest.run_backtest"})
    return {"available": True, **json.loads(BACKTEST_JSON.read_text())}
