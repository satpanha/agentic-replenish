"""FastAPI app: tool endpoints (plug-in surface), agent endpoint, approval queue, dashboard."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import config, store
from app.agent import run_agent
from app.registry import TOOLS, call_tool, openai_tool_schema
from app.service import get_engine

app = FastAPI(title="Agentic Replenishment", version="0.1.0",
              description="Forecast -> risk -> replenishment tools, an LLM orchestrator, and a human-approval gate.")
STATIC = Path(__file__).parent / "static"
BACKTEST_JSON = config.ROOT / "backtest" / "results.json"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    return {"ok": True, "llm_enabled": config.LLM_ENABLED, "model": config.LLM_MODEL or None}


@app.get("/api/overview")
def overview():
    return call_tool("get_portfolio_overview")


# ---- plug-in surface: every tool is callable by any other system --------------------------
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
