/**
 * Derivations. Pure functions from the engine payload (+ demo settings) to view models.
 * No DOM here, so every section computes from the same numbers.
 */
import { SESSION_START, DOC_TYPE_LABEL } from "./demo.js";
import { addDays, cents, dayDate, int, list, money, one, parseDay, plural, shortDate } from "../lib/format.js";

export type Dashboard = import("./types.js").Dashboard;
export type Product = import("./types.js").Product;
export type Status = import("./types.js").Status;
export type Period = import("./types.js").Period;

export function statusOf(p: Product): Status {
  const r = p.reasons;
  if (r.includes("STOCKOUT_RISK")) return { level: "critical", kind: "stockout", label: "Stockout risk", rank: 0 };
  if (p.recommendation) return { level: "warning", kind: "reorder", label: "Reorder now", rank: 1 };
  if (r.includes("EXPIRY_RISK")) return { level: "warning", kind: "expiry", label: "Expiry risk", rank: 2 };
  if (r.includes("EXCESS_STOCK")) return { level: "excess", kind: "excess", label: "Excess stock", rank: 3 };
  if (r.includes("SLOW_MOVING")) return { level: "excess", kind: "slow", label: "Slow moving", rank: 3 };
  return { level: "healthy", kind: "healthy", label: "Healthy", rank: 4 };
}

/** Secondary sort inside a status group: most urgent / most money first. */
function urgency(p: Product) {
  const s = statusOf(p);
  if (s.kind === "stockout") return -p.margin_at_risk;
  if (s.kind === "reorder") return p.days_cover_incl_pipeline / p.lead_time_days;
  if (s.kind === "expiry") return -p.value_at_risk;
  if (s.level === "excess") return -p.excess_capital;
  return p.days_cover_incl_pipeline / p.lead_time_days;
}

export const supplierMap = (d: Dashboard) => Object.fromEntries(d.suppliers.map((s) => [s.supplier_id, s]));

/** Forecast units over the next `days`. */
export const forecastUnits = (p: Product, days: number) => p.forecast.values.slice(0, days).reduce((a, b) => a + b, 0);

/** Date the shelf is projected to run empty (stock + open orders, forecast demand). */
export const runOutDate = (d: Dashboard, p: Product) => addDays(parseDay(d.as_of), Math.floor(p.days_cover_incl_pipeline));

export const deliveryDate = (d: Dashboard, p: Product) => addDays(parseDay(d.as_of), Math.ceil(p.lead_time_days));

export const gapDays = (p: Product) => Math.max(0, p.lead_time_days - p.days_cover_incl_pipeline);

// ---- B: metrics -------------------------------------------------------------------------------

/** Supplier changes read from documents that nobody has confirmed yet. They inform, never calculate. */
export function pendingUpdates(docs: import("./types.js").InboxDoc[]): (import("./types.js").SupplierUpdate & {doc: string})[] {
  const t0 = docs.length ? Math.min(...docs.map((x) => +new Date(x.received_at))) : 0;
  return docs.filter((x) => x.headlines?.length && x.supplier_id && ["uploaded", "processing", "needs_review"].includes(x.state)).flatMap((x) => (x.headlines || []).map((h, i) => {
    return {
      id: `${x.id}-${i}`, doc: x.id, kind: h.kind, supplier_id: (x.supplier_id as string), source: DOC_TYPE_LABEL[x.type], document: x.name,
      received_min: Math.round((+new Date(x.received_at) - t0) / 60000), effective: h.effective, sku: h.sku,
      new_unit_cost: h.new_unit_cost, new_lead_time_days: h.new_lead_time_days, confidence: h.confidence,
    };
  }));
}

export function metrics(d: Dashboard, period: Period, budget: number) {
  const ps = d.products;
  const critical = ps.filter((p) => statusOf(p).level === "critical");
  // products that are fine today but cross their lead time within the period if nothing is ordered
  const soon = ps.filter((p) => statusOf(p).level !== "critical" && p.daily_forecast > 0 && p.days_cover_incl_pipeline < p.lead_time_days + period);
  const excess = ps.filter((p) => p.excess_capital > 0);
  const recs = ps.filter((p) => p.recommendation);
  const spend = recs.reduce((a, p) => a + (p.recommendation?.line_cost || 0), 0);
  return {
    atRisk: { count: critical.length, soon: soon.length, soonNames: soon.map((p) => p.name), by: addDays(parseDay(d.as_of), period - 1) },
    margin: { value: critical.reduce((a, p) => a + p.margin_at_risk, 0), units: critical.reduce((a, p) => a + gapDays(p) * p.daily_forecast, 0), count: critical.length },
    dead: { value: excess.reduce((a, p) => a + p.excess_capital, 0), count: excess.length, threshold: d.policy.excess_cover_days },
    spend: { value: spend, lines: recs.length, suppliers: new Set(recs.map((p) => p.supplier_id)).size, budget, utilisation: budget ? spend / budget : 0 },
  };
}

/** One-line briefing. */
export function summary(d: Dashboard) {
  const ps = d.products;
  const groups = { critical: 0, warning: 0, excess: 0, healthy: 0 };
  ps.forEach((p) => groups[statusOf(p).level]++);
  const reorder = ps.filter((p) => statusOf(p).kind === "reorder").length;
  const decisions = groups.critical + reorder;
  const stable = groups.healthy + groups.excess;
  return { stable, total: ps.length, decisions, critical: groups.critical, reorder, groups };
}

// ---- C: table ---------------------------------------------------------------------------------

export const FILTERS = (([
  { id: "attention", label: "Needs attention", levels: ["critical", "warning"] },
  { id: "critical", label: "Critical", levels: ["critical"] },
  { id: "warning", label: "Warning", levels: ["warning"] },
  { id: "excess", label: "Excess", levels: ["excess"] },
  { id: "healthy", label: "Healthy", levels: ["healthy"] },
  { id: "all", label: "All", levels: ["critical", "warning", "excess", "healthy"] },
]) as const);

export type SortKey = "priority"|"name"|"stock"|"dos"|"forecast"|"lead"|"qty"|"cost"|"status";
export type Sort = {key: SortKey, dir: 1 | -1};

function sortValue(p: Product, key: SortKey, period: Period): number | string {
  switch (key) {
    case "name": return p.name.toLowerCase();
    case "stock": return p.stock;
    case "dos": return p.days_cover_incl_pipeline;
    case "forecast": return forecastUnits(p, period);
    case "lead": return p.lead_time_days;
    case "qty": return p.recommendation?.qty ?? -1;
    case "cost": return p.recommendation?.line_cost ?? -1;
    case "status": return statusOf(p).rank;
    default: return statusOf(p).rank * 1e6 + urgency(p);
  }
}

export function tableRows(d: Dashboard, q: {query: string, filter: string, category: string, sort: Sort, period: Period}) {
  const f = FILTERS.find((x) => x.id === q.filter) || FILTERS[0];
  const sup = supplierMap(d);
  const needle = q.query.trim().toLowerCase();
  const rows = d.products.filter((p) => {
    if (!((f.levels as readonly string[])).includes(statusOf(p).level)) return false;
    if (q.category !== "all" && p.category !== q.category) return false;
    if (!needle) return true;
    return [p.name, p.sku, p.category, sup[p.supplier_id]?.name || ""].some((s) => s.toLowerCase().includes(needle));
  });
  const { key, dir } = q.sort;
  return rows.sort((a, b) => {
    const va = sortValue(a, key, q.period), vb = sortValue(b, key, q.period);
    const c = typeof va === "string" ? va.localeCompare((vb as string)) : (va as number) - (vb as number);
    return c * dir || statusOf(a).rank - statusOf(b).rank;
  });
}

export function levelCounts(d: Dashboard): Record<import("./types.js").Level | "attention" | "all", number> {
  const c: Record<import("./types.js").Level, number> = { critical: 0, warning: 0, excess: 0, healthy: 0 };
  d.products.forEach((p) => c[statusOf(p).level]++);
  return { ...c, attention: c.critical + c.warning, all: d.products.length };
}

// ---- D: forecast chart ------------------------------------------------------------------------

export const CHART_HISTORY_DAYS = 42;

export function chartSeries(d: Dashboard, p: Product, period: Period) {
  const today = parseDay(d.as_of);
  const hist = p.forecast.history.slice(-CHART_HISTORY_DAYS);
  const sma = p.forecast.history.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const z = 1.2816; // 80% two-sided interval
  const s = p.forecast.sigma_daily;
  const fc = p.forecast.values.slice(0, period);
  return {
    today,
    history: hist.map((v, i) => ({ date: addDays(today, i - hist.length), value: v })),
    forecast: fc.map((v, i) => ({ date: addDays(today, i), value: v, lo: Math.max(0, v - z * s), hi: v + z * s })),
    sma,
    leadTime: p.lead_time_days,
    total: fc.reduce((a, b) => a + b, 0),
    smaTotal: sma * period,
  };
}

// ---- E: insights ------------------------------------------------------------------------------

export function insights(d: Dashboard, pending: ReturnType<typeof pendingUpdates> = []): import("./types.js").Insight[] {
  const sup = supplierMap(d);
  const by = Object.fromEntries(d.products.map((p) => [p.sku, p]));
  const out: import("./types.js").Insight[] = [];

  const critical = d.products.filter((p) => statusOf(p).kind === "stockout").sort((a, b) => b.margin_at_risk - a.margin_at_risk);
  critical.slice(0, 1).forEach((p) => {
    const s = sup[p.supplier_id];
    out.push({
      id: `stockout-${p.sku}`, severity: "critical", source: "calc", subject: `${p.name} · ${s.name}`,
      title: `${p.name} runs out ${p.days_cover_incl_pipeline < 1 ? "today" : `in ${one(p.days_cover_incl_pipeline)} days`}`,
      body: `Selling about ${int(p.daily_forecast)} a day with ${int(p.stock + p.on_order)} in stock and on order. A new order from ${s.name} takes ${int(p.lead_time_days)} days to arrive.`,
      impact: `About ${one(gapDays(p))} days without stock · ${money(p.margin_at_risk)} gross margin at risk`,
      cta: { label: "Review SKU", action: "open-sku", arg: p.sku },
    });
  });
  if (critical.length > 1) {
    const rest = critical.slice(1);
    out.push({
      id: "stockout-rest", severity: "critical", source: "calc", subject: plural(rest.length, "more product"),
      title: `${list(rest.map((p) => p.name))} also run out before delivery`,
      body: `Recommended orders are ready: ${list(rest.map((p) => `${int(p.recommendation?.qty || 0)} × ${p.name}`))}.`,
      impact: `${money(rest.reduce((a, p) => a + p.margin_at_risk, 0))} gross margin at risk`,
      cta: { label: "Open Purchasing Cart", action: "go", arg: "cart" },
    });
  }

  for (const u of pending) {
    const s = sup[u.supplier_id];
    if (!s) continue;
    if (u.kind === "price_change" && u.sku && by[u.sku] && u.new_unit_cost) {
      const p = by[u.sku];
      const delta = u.new_unit_cost - p.unit_cost;
      const qty = p.recommendation?.qty || 0;
      const marginBefore = (p.unit_price - p.unit_cost) / p.unit_price;
      const marginAfter = (p.unit_price - u.new_unit_cost) / p.unit_price;
      out.push({
        id: u.id, severity: "warning", source: "ai", subject: `${s.name} · ${u.source}`,
        title: `${p.name} unit cost rises ${((delta / p.unit_cost) * 100).toFixed(1)}% from ${u.effective}`,
        body: `Price list says ${cents(p.unit_cost)} → ${cents(u.new_unit_cost)}. At the current shelf price, the margin on this product drops from ${(marginBefore * 100).toFixed(0)}% to ${(marginAfter * 100).toFixed(0)}%.`,
        impact: qty ? `+${cents(delta * qty)} on the recommended ${int(qty)}-unit order` : "No open recommendation affected",
        cta: { label: "Inspect Supplier Update", action: "open-doc", arg: u.doc },
      });
    }
    const newLt = u.new_lead_time_days;
    if (u.kind === "lead_time_change" && newLt) {
      const extra = newLt - s.lead_time_days;
      const hit = d.products.filter((p) => p.supplier_id === u.supplier_id && p.days_cover_incl_pipeline < newLt);
      const extraMargin = hit.reduce((a, p) => a + p.daily_forecast * Math.min(extra, newLt - p.days_cover_incl_pipeline) * (p.unit_price - p.unit_cost), 0);
      out.push({
        id: u.id, severity: "warning", source: "ai", subject: `${s.name} · ${u.source}`,
        title: `Lead time ${int(s.lead_time_days)} → ${int(newLt)} days from ${s.name}`,
        body: hit.length
          ? `${list(hit.map((p) => p.name))} would wait ${plural(extra, "more day")} for stock. The order plan still uses ${int(s.lead_time_days)} days until this update is confirmed.`
          : `No product from this supplier is short at the longer lead time.`,
        impact: hit.length ? `+${money(extraMargin)} gross margin at risk if confirmed` : "No margin impact",
        cta: hit.length ? { label: "View Forecast", action: "view-forecast", arg: hit.sort((a, b) => b.margin_at_risk - a.margin_at_risk)[0].sku } : { label: "Inspect Supplier Update", action: "open-doc", arg: u.doc },
      });
    }
  }

  const unsold = (p: Product) => Math.max(0, p.stock - Math.max(0, p.days_to_expiry ?? 0) * p.daily_forecast);
  const expiry = d.products.filter((p) => statusOf(p).kind === "expiry" && unsold(p) * p.unit_cost >= 500)
    .sort((a, b) => (a.days_to_expiry ?? 1e9) - (b.days_to_expiry ?? 1e9))[0];
  if (expiry) {
    const left = unsold(expiry);
    out.push({
      id: `expiry-${expiry.sku}`, severity: "warning", source: "calc", subject: `${expiry.name} · ${sup[expiry.supplier_id].name}`,
      title: `${int(left)} units of ${expiry.name} won't sell before expiry`,
      body: `The earliest batch expires ${expiry.earliest_expiry_date ? shortDate(parseDay(expiry.earliest_expiry_date)) : "soon"}, in ${plural(expiry.days_to_expiry ?? 0, "day")}. At ${int(expiry.daily_forecast)} a day, about ${int(expiry.stock - left)} of ${int(expiry.stock)} units will sell by then. Hold further orders and plan a markdown.`,
      impact: `${money(left * expiry.unit_cost)} of stock at cost would be written off`,
      cta: { label: "Review SKU", action: "open-sku", arg: expiry.sku },
    });
  }
  return out;
}

// ---- F: activity ------------------------------------------------------------------------------

export function activity(d: Dashboard, docs: import("./types.js").InboxDoc[] = [], budget: number = 0): import("./types.js").ActivityItem[] {
  const counts = levelCounts(d);
  const m = metrics(d, 14, budget);
  const sup = supplierMap(d);
  const at = (minute: number) => sessionTime(d, minute).toISOString();
  const items: import("./types.js").ActivityItem[] = [
    { minute: 0, at: at(0), kind: "sys", text: "Inventory data synchronized", detail: `${d.products.length} SKUs, ${d.suppliers.length} suppliers from ${d.is_sample_data ? "sample" : "imported"} CSVs` },
    { minute: 2, at: at(2), kind: "calc", text: "Demand forecasts refreshed", detail: `${d.products.length} models selected by backtest error` },
    { minute: 3, at: at(3), kind: "risk", text: "Risks identified", detail: `${counts.critical} stockout, ${d.products.filter((p) => p.reasons.includes("EXPIRY_RISK")).length} expiry, ${d.products.filter((p) => p.excess_capital > 0).length} excess` },
    { minute: 4, at: at(4), kind: "calc", text: "Purchasing recommendation generated", detail: `${plural(m.spend.lines, "line")} across ${plural(m.spend.suppliers, "supplier")}, ${money(m.spend.value)}` },
    ...docs.filter((x) => x.state !== "failed").map((x) => (({
      minute: 0, at: x.verified_at || x.received_at, kind: x.state === "verified" ? "sys" : "ai",
      text: x.state === "verified" ? "Supplier update confirmed" : "Supplier document received",
      detail: `${x.supplier_id ? sup[x.supplier_id]?.name : "Unknown supplier"}: ${DOC_TYPE_LABEL[x.type].toLowerCase()}${x.state === "verified" ? ", applied to calculations" : x.method === "simulated" ? ", read by the extractor (simulated)" : ""}`,
    }) as import("./types.js").ActivityItem)),
  ];
  return items.sort((a, b) => +new Date(b.at || 0) - +new Date(a.at || 0)).slice(0, 8);
}

export const sessionTime = (d: Dashboard, minute: number) => {
  const t = parseDay(d.as_of);
  t.setHours(SESSION_START.hour, SESSION_START.minute + minute);
  return t;
};

// ---- drawer copy ------------------------------------------------------------------------------

/** Plain-English reason for the status, built from the same numbers. */
export function explain(d: Dashboard, p: Product) {
  const s = statusOf(p);
  const sup = supplierMap(d)[p.supplier_id];
  const runOut = dayDate(runOutDate(d, p));
  const arrive = dayDate(deliveryDate(d, p));
  switch (s.kind) {
    case "stockout":
      return `Stock and open orders cover ${one(p.days_cover_incl_pipeline)} days, so the shelf empties around ${runOut}. An order placed today with ${sup.name} arrives around ${arrive}, leaving about ${one(gapDays(p))} days with nothing to sell.`;
    case "reorder":
      return `Stock and open orders cover ${one(p.days_cover_incl_pipeline)} days, which falls below the reorder point before the next review. Ordering now keeps the shelf full through the ${int(p.lead_time_days)}-day lead time.`;
    case "expiry":
      return `${int(p.stock)} units on hand, but the earliest batch expires in ${plural(p.days_to_expiry ?? 0, "day")} and only about ${int((p.days_to_expiry ?? 0) * p.daily_forecast)} will sell by then.`;
    case "excess":
    case "slow":
      return `${int(p.days_cover_incl_pipeline)} days of cover against a ${int(d.policy.excess_cover_days)}-day ceiling. No reorder is needed; consider promotions or returning stock to free ${money(p.excess_capital)} of working capital.`;
    default:
      return `${int(p.days_cover_incl_pipeline)} days of cover against a ${int(p.lead_time_days)}-day lead time. No action needed this cycle.`;
  }
}
