# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Two primary users, weighted equally:
- **Owner-operators** of small and medium retail stores (minimarts and groceries, roughly 1–5 stores). They do the purchasing themselves while running the shop, have little time and no analyst.
- **Purchasing leads** at small chains. They review recommendations and draft orders as a daily routine, and the owner holds the budget.

Their shared job: decide what to reorder, how much and from whom, before shelves run empty, without tying cash up in stock that won't sell.

Secondary audience (current): **AMD hackathon Track 3 judges**, who evaluate the working demo. Their criteria (from README): AMD powers part of the product, predictions are explainable rather than LLM-only, the effect is measurable, and a human approves.

## Product Purpose
StockPulse AMD (repo name: Agentic Replenishment Copilot) turns the data a retailer already has into explained purchasing decisions:
1. sales history, stock levels and messy supplier documents go in;
2. demand forecasts, risk flags and constraint-aware order quantities come out;
3. an agent explains the trade-offs and prepares purchase order drafts.

Success means fewer stockouts and less dead stock, decided in minutes, with every number traceable to how it was calculated.

## Positioning
The math and the AI are deliberately separated. Forecasts, risk scores and order quantities come from deterministic, backtested code. AI running on AMD infrastructure reads supplier documents, plans the tool calls and explains the results in plain language, and it never produces the numbers. The product shows which is which, so a retailer can trust a recommendation without trusting a black box.

## Operating Context
- **Data in:** POS sales and stock CSVs in a canonical schema (`sales`, `inventory`, `suppliers`; see README), plus supplier PDFs, price lists and emails (the AI-extraction path, planned for the Supplier Inbox).
- **Rhythm:** a periodic review (default every 7 days) at a 95% service level. Lead times vary by supplier, from 3 to 14 days in the sample data.
- **Real constraints in the domain:** pack sizes, MOQs, supplier minimum order values, shelf life and expiry, and a purchasing budget.
- **Integration surface:** every tool is callable over REST (`POST /api/tools/{name}`), MCP is planned, and an Evolus workflow integration is optional.
- **Model:** AMD Token Factory (OpenAI-compatible tool calling). There's an offline fallback that uses the same tools with templated explanations.

## Capabilities and Constraints
- **Built:** the forecast tool (seasonal naive, moving average, seasonal exponential smoothing and damped-trend smoothing, chosen by holdout WAPE), the risk tool (stockout, expiry, excess, slow-moving), the replenishment tool (order-up-to policy with safety stock, rounded to pack size and MOQ), an LLM orchestrator, a PO approval queue, a 12-week backtest, and the Phase 1 web app (Overview command center; `GET /api/dashboard`).
- **Approval gate (current implementation):** the agent can only create PENDING drafts, approve and reject require an approver key, and the tool registry has no approve tool. Not confirmed as a binding product commitment; treat it as open and ask before changing it.
- **Phase 2, not built:** Inventory, Demand Forecasts, Risk Radar, Supplier Inbox, Purchasing Cart, Purchase Orders, and Settings & Integrations pages; CSV upload into the engine; the MCP server; PO PDF generation and supplier dispatch.
- **Terminology:** days of supply = (stock + on order) ÷ forecast daily demand; WAPE; SMA-14 baseline; reorder point; safety stock; lead time; MOQ; pack size; dead-stock capital.
- **Undecided:** currency (the UI currently shows USD), multi-store support, and the auth model beyond the approver key.

## Brand Commitments
- Name: **StockPulse AMD**.
- **Deterministic versus AI is always visible.** Forecasts, risk and quantities are code; AI is for extraction, inference and explanation. The UI labels which produced each number.
- **Data stays private.** Pricing and margin data stays on private infrastructure (on-prem / AMD Developer Cloud).
- **Honest numbers only.** Sample data is always labelled as sample. No invented customers, testimonials, savings or benchmarks. Backtest results always appear with their caveats.

## Evidence on Hand
- **Sample dataset:** `app/data_sample/` holds 34 SKUs, 5 suppliers named in a Cambodian setting (Mekong Fresh Foods, Angkor Beverage Co, Phnom Penh Household Supply, and others) and 540 days of sales. It is synthetic.
- **Backtest:** `backtest/results.json` is a 12-week replay against a static min/max rule. Its caveats must accompany it: synthetic data, sales are used as demand, the baseline is deliberately simple, and forecast accuracy is about equal to a trailing mean (the gain comes from safety stock and pipeline-aware ordering).
- **Architecture diagram:** `StockPulse AMD_ Autonomous Procurement Flow.png`.
- **Absent, so never fabricate:** real customers, testimonials, press, live store data, production metrics and pricing.

## Product Principles
1. **Show the calculation.** Every recommendation can be opened down to its inputs: forecast, lead time, safety stock, pack rounding.
2. **Label provenance.** Calculated, AI-extracted and sample are visibly different, everywhere.
3. **Decisions over dashboards.** Lead with what needs a purchasing decision today, then the evidence for it.
4. **Never overstate.** If the data is sample, the baseline weak or a feature not built, say so in the product itself.
5. **Fit a small retailer's day.** Assume a busy, non-analyst user: plain language, few steps, safe defaults.
