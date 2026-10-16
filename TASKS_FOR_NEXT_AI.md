# Remaining tasks (hand this file to another AI / teammate)

Context: the foundation in this repo already runs end-to-end (tools, agent, API, approval queue, dashboard, backtest, 8 passing tests).
Do NOT rewrite the tools. Keep `app/registry.py` as the single source of tool definitions. Never add an approve tool for the agent.

## Must do (needed to submit)

1. **Wire AMD Token Factory** (15 min). Fill `.env` (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) from the hackathon page. Run the dashboard "Run inventory review"; confirm the header chip shows the model and `mode: "llm"` in `/api/agent/run`. If the model rejects `tools`/`tool_choice`, fix `_llm_loop` in `app/agent.py` (e.g. try a different model, or fall back to JSON-mode planning). Keep the offline fallback.
2. **Docker check** (10 min). `docker compose up --build`, open <http://localhost:8000>, confirm risk table, agent run, approve a PO. Fix anything that fails. (Dockerfile was written but not executed.)
3. **Public GitHub repo** (10 min). Confirm `.env` is not committed (`git ls-files | grep .env` must show only `.env.example`). Push.
4. **README polish + screenshots** (15 min). Add 2-3 dashboard screenshots and the final backtest numbers from `backtest/results.json`. Keep the caveats paragraph.
5. **Demo script/video** (30 min). 2-minute flow: dashboard risks -> "Run inventory review" (show tool-call trace) -> PO appears pending -> approve -> backtest KPIs. Say clearly: forecast is statistical, LLM explains and acts, AMD runs the copilot.

## Should do if time allows

6. **MCP server** (`mcp_server.py` is a placeholder): expose `app.registry.TOOLS` via the official `mcp` Python SDK (stdio), calling `call_tool`. Add a one-line usage example to the README.
2. **CSV upload adapter**: `POST /api/data/upload` accepting the 3 canonical CSVs (validate columns, write to a temp DATA_DIR, call `Engine.load()` and clear caches). Add a test.

## Optional

8. **Evolus partner prize**: only after confirming in the lablab Discord that the Token Factory API counts as the required vLLM/AMD endpoint. Build one workflow (forecast -> risk -> PO draft -> approval) calling this repo's REST tools.

## Known limitations to mention honestly in the submission

- Synthetic sample data; backtest treats sales as demand (no lost-sales censoring).
- Baseline in the backtest is a simple static min/max rule.
- Tool endpoints have no auth; only approve/reject require `X-Approver-Key`.
