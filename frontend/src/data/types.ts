/** Shared data shapes. `Dashboard` mirrors GET /api/dashboard (app/dashboard.py); the rest are
front-end demo data or derived view models. Types only; nothing here runs. */
export type RiskReason = "STOCKOUT_RISK" | "EXPIRY_RISK" | "EXCESS_STOCK" | "SLOW_MOVING";
export interface Recommendation {
  qty: number;
  line_cost: number;
  reorder_point: number;
  safety_stock: number;
  demand_over_lead_time: number;
}
export interface ForecastSeries {
  method: string;
  /** holdout WAPE of the selected model */
  wape: number;
  /** holdout WAPE of a 14-day simple moving average, same window */
  sma14_wape: number | null;
  sigma_daily: number;
  /** last 56 days of unit sales, oldest first, ending yesterday */
  history: number[];
  /** 28-day daily forecast starting today */
  values: number[];
}
export interface Product {
  sku: string;
  name: string;
  category: string;
  supplier_id: string;
  stock: number;
  on_order: number;
  unit_cost: number;
  unit_price: number;
  pack_size: number;
  moq: number;
  shelf_life_days: number | null;
  earliest_expiry_date: string | null;
  days_to_expiry: number | null;
  daily_forecast: number;
  /** on-hand stock / forecast daily demand */
  days_cover: number;
  /** (on-hand + on order) / forecast daily demand */
  days_cover_incl_pipeline: number;
  lead_time_days: number;
  lead_time_std_days: number;
  primary_reason: "OK" | RiskReason;
  reasons: RiskReason[];
  risk_score: number;
  value_at_risk: number;
  margin_at_risk: number;
  excess_capital: number;
  forecast: ForecastSeries;
  recommendation: Recommendation | null;
  /** confirmed supplier changes applied to this SKU */
  updates?: {id: number, field: string, old_value: number | null, new_value: number, effective: string | null, source_doc: string | null, confirmed_at: string, confirmed_by: string}[];
  /** purchase orders containing this SKU */
  orders?: {id: number, status: string, qty: number, line_cost: number, created_at: string, updated_at: string, events: {at: string, action: string, status: string, by: string, note: string}[]}[];
}
export interface Supplier {
  supplier_id: string;
  name: string;
  lead_time_days: number;
  lead_time_std_days: number;
  min_order_value: number;
}
export interface Dashboard {
  /** first forecast day ("today" in the data) */
  as_of: string;
  history_start: string;
  /** when the engine computed this payload (UTC ISO) */
  generated_at: string;
  is_sample_data: boolean;
  policy: {service_level: number, review_days: number, excess_cover_days: number};
  suppliers: Supplier[];
  drafts: {supplier_id: string, total_cost: number, warnings: string[], skus: string[]}[];
  products: Product[];
}
export type Level = "critical" | "warning" | "excess" | "healthy";
export type Kind = "stockout" | "reorder" | "expiry" | "excess" | "slow" | "healthy";
export type Status = {level: Level, kind: Kind, label: string, rank: number};
export interface SupplierUpdate {
  id: string;
  kind: "price_change" | "lead_time_change";
  supplier_id: string;
  /** e.g. "PDF price list" */
  source: string;
  /** file or message name */
  document: string;
  /** minutes after the demo session clock start */
  received_min: number;
  /** human date text */
  effective: string;
  sku?: string;
  new_unit_cost?: number;
  new_lead_time_days?: number;
  /** extractor confidence 0..1 */
  confidence: number;
}
export type Period = 7 | 14 | 28;
export interface Insight {
  id: string;
  severity: "critical" | "warning" | "info";
  source: "calc" | "ai";
  subject: string;
  title: string;
  body: string;
  impact: string;
  cta: {label: string, action: string, arg?: string};
}
export type DocState = "uploaded" | "processing" | "needs_review" | "verified" | "failed" | "rejected";
export interface ExtractedLine {
  id: string;
  /** item = per-SKU terms, supplier = supplier-wide terms (lead time) */
  kind: "item" | "supplier";
  /** product or clause exactly as written in the document */
  text: string;
  /** matched SKU (item lines) */
  sku: string | null;
  fields: {unit_cost?: number | null, moq?: number | null, pack_size?: number | null, lead_time_days?: number | null, effective?: string | null};
  /** extractor confidence per field (0..1); absent for manual entry */
  conf: Record<string, number>;
  /** where in the source it was read */
  ref: string;
  include: boolean;
  /** a person changed at least one value */
  edited?: boolean;
}
export interface InboxDoc {
  id: string;
  name: string;
  supplier_id: string | null;
  type: "price_list" | "invoice" | "catalog" | "notice" | "email" | "other";
  /** ISO local time */
  received_at: string;
  state: DocState;
  origin: "fixture" | "upload" | "paste";
  /** how the lines were produced */
  method: "simulated" | "rules" | "manual" | null;
  size?: number;
  /** pasted email text */
  text?: string;
  error?: string;
  lines: ExtractedLine[];
  /** what the simulated extractor returns for this sample */
  fixtureLines?: ExtractedLine[];
  /** supplier changes this document reports (what the Overview flags until it is reviewed) */
  headlines?: {kind: "price_change" | "lead_time_change", sku?: string, new_unit_cost?: number, new_lead_time_days?: number, effective: string, confidence: number}[];
  /** epoch ms when simulated extraction started */
  processing_started?: number;
  verified_at?: string;
  confirmed_ids?: number[];
}
export interface ForecastDetail {
  sku: string;
  name: string;
  category: string;
  supplier_id: string;
  supplier_name: string;
  as_of: string;
  history_start: string;
  history: number[];
  forecast: {value: number, lo: number, hi: number}[];
  sma14: number;
  model: {method: string, candidates: Record<string, number>, sigma_daily: number, interval: string};
  holdout: {start: string, days: number, actual: number[], model: number[], sma14: number[], metrics: {model: Metrics, sma14: Metrics}};
  factors: Record<string, any>;
  source: "engine";
}
export type Metrics = {wape: number, mae: number, rmse: number, bias: number, mape: number | null, mape_note: string | null, n: number};
export interface OptLine {
  sku: string;
  name: string;
  supplier_id: string;
  supplier_name: string;
  tier: 0 | 1 | 2;
  priority: number;
  unit_cost: number;
  pack_size: number;
  moq: number;
  lead_time_days: number;
  review_days: number;
  position: number;
  daily_forecast: number;
  cover_days: number;
  recommended_qty: number;
  protection_qty: number;
  qty: number;
  line_cost: number;
  status: "full" | "reduced" | "deferred";
  safety_stock: number;
  reorder_point: number;
  order_up_to: number;
  demand_over_lead_time: number;
  demand_over_review: number;
  shortfall_units_if_deferred: number;
  margin_at_risk_if_deferred: number;
  cover_after_days: number;
  reason: string;
}
export interface Optimization {
  method: "greedy-heuristic";
  assumptions: string[];
  service_level: number;
  review_days: number;
  lead_time_overrides: Record<string, number>;
  budget: number;
  spend: number;
  remaining: number;
  utilisation: number | null;
  unconstrained_spend: number;
  counts: {full: number, reduced: number, deferred: number};
  suppliers: {supplier_id: string, name: string, subtotal: number, min_order_value: number, meets_minimum: boolean}[];
  lines: OptLine[];
}
export interface AssistantAnswer {
  intent: string;
  answer: string;
  draft?: string;
  facts: {label: string, value: string, source: "calc" | "forecast" | "extracted"}[];
  links: {kind: "sku" | "cart" | "cart_line" | "risk", id: string, label: string}[];
  tools_run: string[];
  mode: "deterministic" | "llm";
  model: string | null;
  note?: string;
}
export type POStatus = "draft" | "pending" | "approved" | "rejected" | "sent" | "acknowledged" | "cancelled" | "superseded";
export interface PurchaseOrder {
  id: number;
  supplier_id: string;
  supplier_name: string;
  status: POStatus;
  total_cost: number;
  lead_time_days: number;
  lines: {sku: string, name: string, qty: number, unit_cost: number, line_cost: number, recommended_qty?: number | null, pack_size?: number, moq?: number, forecast_method?: string, forecast_wape?: number}[];
  warnings: string[];
  rationale: string;
  created_at: string;
  created_by: string;
  decided_at: string | null;
  decided_by: string | null;
  updated_at: string;
  events: {at: string, action: string, status: string, by: string, note: string}[];
  terms: {currency?: string, budget?: number, service_level?: number, payment_terms?: string | null};
  /** dispatch attempts through integration points; "simulated" never means anything was sent */
  dispatch?: DispatchRecord[];
}
export interface ConfirmedUpdate {
  id: number;
  supplier_id: string;
  sku: string | null;
  field: string;
  old_value: number | null;
  new_value: number;
  effective: string | null;
  source_doc: string | null;
  source_ref: string | null;
  confirmed_by: string;
  confirmed_at: string;
  reverted_at: string | null;
}
export interface ActivityItem {
  minute: number;
  /** ISO time; sample engine events use the demo session clock */
  at?: string;
  kind: "calc" | "ai" | "sys" | "risk";
  text: string;
  detail?: string;
}


/** GET /api/data/status */
export interface DataStatus {
  source: "sample" | "imported";
  skus: number;
  suppliers: number;
  history_days: number;
  as_of: string;
}

/** POST /api/data/check */
export interface DataCheck {
  ok: boolean;
  errors: string[];
  tables: Record<string, { source: "upload" | "current"; rows: number | null; errors: string[] }>;
}

/** One dispatch attempt recorded on a purchase order. */
export interface DispatchRecord {
  at: string;
  channel: "email" | "webhook" | "evolus";
  channel_label: string;
  mode: "simulated";
  by: string;
  result: string;
}
