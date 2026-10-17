# Agentic Replenishment Copilot

Three plug-in tools + an LLM orchestrator + a human-approval gate, for the AMD hackathon Track 3.

```
Other apps / Evolus / MCP clients ──► REST  POST /api/tools/{name}
                                          │
        Orchestrator agent (LLM on AMD Token Factory, OpenAI-compatible tool calling)
           │ plans · explains · writes PO rationale        (never computes numbers)
   ┌───────┼────────────────┬──────────────────────┐
forecast_demand   detect_inventory_risk   optimize_replenishment     ← deterministic code
   └───────┴────────────────┴──────────────────────┘
                  canonical CSV schema (sales · inventory · suppliers)
                              │
        create_purchase_order_drafts → status PENDING → human approves (X-Approver-Key)
```

## Run

```bash
pip install -r requirements.txt
python -m app.data_gen                 # (re)generate sample data, already included
python -m backtest.run_backtest        # writes backtest/results.json (shown in the dashboard)
cp .env.example .env                   # fill LLM_BASE_URL / LLM_API_KEY / LLM_MODEL from AMD Token Factory
npm install && npm run build           # compile the TypeScript frontend (npm run dev: rebuild on save)
uvicorn app.main:app --reload          # http://localhost:8000
pytest -q                              # 8 tests
# or: docker compose up --build
```
With no `LLM_*` variables the app runs in **offline mode** (same tools, templated explanation) so nothing breaks.

## Frontend: StockPulse AMD
`/` serves the app from the `frontend/` folder. It is written in **TypeScript** (strict mode): sources in `frontend/src/`, compiled by `tsc` into `frontend/dist/` (`npm run build`, `npm run dev` to watch, `npm run typecheck`). There is no bundler; the browser loads the compiled ES modules directly, and an import map points `animejs` at `frontend/vendor/`. The original console stays at `/console`.

| Page | What it does | Data source |
|---|---|---|
| Overview | Briefing, metrics, priority purchasing, forecast, alerts | `GET /api/dashboard` |
| Inventory | Every SKU, filters, bulk add, product drawer | `GET /api/dashboard` |
| Demand Forecasts | Forecast + 80% interval, SMA-14 baseline, holdout WAPE/MAE/RMSE/MAPE/bias, drivers | `GET /api/forecast/{sku}` |
| Risk Radar | Stockout, overstock/expiry, margin erosion, lead-time and budget risks by fixed rules | dashboard + optimizer + inbox (`js/data/risk.js`) |
| Supplier Inbox | Intake, review and confirmation of supplier documents | sample fixtures (simulated extraction); confirmed values via `POST /api/supplier-updates` |
| Purchasing Cart | Editable lines, pack/MOQ/budget/supplier-minimum validation, what-if simulator, PO drafts | `POST /api/optimize`, `POST /api/pos/drafts` |
| Purchase Orders | List, detail, approval history, printable preview | `/api/pos`, `/api/pos/{id}/{submit,approve,reject,mark_sent,acknowledge,cancel}` |
| Settings | Budget, engine policy, data import/reset, confirmed updates, integration status | `/api/data/*`, `/api/health` |

Tests: `pytest -q` (engine and API) and `npm test` (type-check, then Playwright: the frontend's calculations plus the full Phase 2 demo journey in Chromium against a real engine on a throwaway database).

Purchase orders: draft → submit → approve, or **return for revision** with a required note. Approval is blocked until the pre-approval checks pass (whole cases, MOQs, totals add up, supplier minimum; changed trusted prices are flagged). Dispatch through email, webhook or Evolus is **simulated only** and recorded as such; it never marks an order sent. "Record that I sent it" is for orders you sent yourself.

Honesty rules built into the UI: the budget optimizer (`app/tools/budget.py`) is a stated greedy heuristic, not a MILP solver. Document extraction is simulated on sample fixtures; your own files are reviewed by hand. The assistant (`POST /api/assistant`) answers deterministically, lists the functions it ran, and lets an LLM only rephrase when one is configured (rewording that introduces new numbers is rejected). "Sent" and "acknowledged" are recorded by a person; nothing is transmitted.
Code layout (`frontend/`): `css/tokens.css` → `components.css` → `shell.css` / `overview.css` / `pages.css`; `src/data/*` (API, types, calculations, demo fixtures), `src/state.ts` (store + actions), `src/ui/*` (shell, chart, drawers, dialog, assistant), `src/lib/*` (helpers, `motion.ts` on Anime.js), `src/pages/*`. Docker compiles the frontend in a Node build stage.

## Why it satisfies Track 3
| Requirement | Where |
|---|---|
| AMD powers part of the working product | `app/agent.py` calls Token Factory for planning, explanations and PO rationale |
| Prediction must be explainable, not LLM-only | `app/tools/forecast.py`: seasonal-naive / moving average / exp. smoothing, chosen by backtest WAPE; every answer states method + WAPE |
| Measurable effect | `backtest/run_backtest.py`: 12-week replay vs a static min/max rule |
| Human approval | `app/store.py`: agent can only create `pending`; approve/reject need `X-Approver-Key`; no approve tool exists in the registry |

## Canonical data schema (adapter target for any other system)
`sales.csv(date,sku,units)` · `inventory.csv(sku,name,category,supplier_id,stock,on_order,unit_cost,unit_price,pack_size,moq,shelf_life_days,earliest_expiry_date)` · `suppliers.csv(supplier_id,name,lead_time_days,lead_time_std_days,min_order_value)`

## Policy (periodic review, protection interval L+R)
`safety = z·sqrt((L+R)σ² + (μσ_L)²)` · `S = demand(L+R) + safety` (capped at 80% of shelf life) · order when `position ≤ S − 0.5·demand(R)` · qty = `S − position` rounded to pack size and MOQ.

## Backtest results (sample data, seed 42) - read the caveats
See `backtest/results.json`. Caveats stated honestly: synthetic data; sales are used as demand; the baseline is a deliberately simple static rule; the copilot places more (smaller) orders; **forecast accuracy is about equal to a trailing mean on this data - the gain comes from safety-stock and pipeline-aware ordering, not from a better forecaster**. Re-run on real data before quoting numbers.

## Security notes
No keys in the repo (`.env` is git-ignored). Change `APPROVER_KEY` before any public deploy. Tool endpoints are unauthenticated by design for the demo.
# agentic-replenish
