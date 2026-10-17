/**
 * Risk Radar rules. Every severity comes from an explicit threshold below; no model output is
 * involved. Language matches certainty: "projected" for forecasts, "if confirmed" for unverified
 * supplier documents, and "not enough data" when the forecast had too little history.
 */
import { cents, int, money, one, pct, plural } from "../lib/format.js";
import { gapDays, pendingUpdates, statusOf } from "./model.js";

export type Severity = "critical" | "high" | "medium" | "low";
export type RiskType = "stockout" | "overstock" | "margin" | "leadtime" | "budget";

export interface RiskItem {
  id: string;
  type: RiskType;
  severity: Severity;
  subject: {kind: "sku" | "supplier", id: string, name: string, category?: string, supplier_id: string};
  title: string;
  /** the key current measurement, e.g. "4.1 days of supply" */
  measure: string;
  leadTime: number | null;
  evidence: string[];
  impact: string;
  /** for sorting */
  impactValue: number;
  source: "calc" | "ai";
  /** the rule that fired, in words */
  rule: string;
  next: {label: string, action: string, arg: string};
  /** data limitation */
  note?: string;
}

export const RISK_TYPES = (([
  { id: "stockout", label: "Imminent stockouts" },
  { id: "overstock", label: "Overstock and dead stock" },
  { id: "margin", label: "Margin erosion" },
  { id: "leadtime", label: "Lead-time bottlenecks" },
  { id: "budget", label: "Budget risk" },
]) as const);
export const SEVERITIES = ((["critical", "high", "medium", "low"]) as const);
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/** @param opt optimizer result at the current budget */
export function riskItems(d: import("./types.js").Dashboard, opt: import("./types.js").Optimization | null, docs: import("./types.js").InboxDoc[]): RiskItem[] {
  const R = d.policy.review_days;
  const out: RiskItem[] = [];
  const subj = (p: import("./types.js").Product) => ({ kind: ("sku" as const), id: p.sku, name: p.name, category: p.category, supplier_id: p.supplier_id });

  for (const p of d.products) {
    const s = statusOf(p);
    const L = p.lead_time_days;
    const cover = p.days_cover_incl_pipeline;
    const thin = p.forecast.method === "insufficient_history";
    // ---- 1. stockouts
    if (p.daily_forecast > 0 && (cover < L + R || p.recommendation)) {
      const sev = ((thin ? "low" : cover < L ? "critical" : cover < L + R ? "high" : "medium") as Severity);
      const nearEdge = cover < L && cover >= L - p.lead_time_std_days;
      out.push({
        id: `stockout-${p.sku}`, type: "stockout", severity: sev, subject: subj(p), source: "calc",
        title: cover < L ? `Projected to run out ${one(gapDays(p))} days before a new delivery` : cover < L + R ? "Runs out before the delivery after next review" : "Below its reorder point",
        measure: `${one(cover)} days of supply`, leadTime: L,
        evidence: [
          `${int(p.stock)} on hand + ${int(p.on_order)} on order ÷ ${one(p.daily_forecast)} a day = ${one(cover)} days`,
          `Lead time ${int(L)} ± ${one(p.lead_time_std_days)} days; review every ${R} days`,
          ...(p.recommendation ? [`Safety stock target ${int(p.recommendation.safety_stock)} units`] : []),
        ],
        impact: cover < L ? `${money(p.margin_at_risk)} gross margin at risk` : `Order needed this cycle${p.recommendation ? `: ${int(p.recommendation.qty)} units` : ""}`,
        impactValue: cover < L ? p.margin_at_risk : (p.recommendation?.line_cost || 0) / 10,
        rule: "Critical when stock + open orders cover less than the lead time; high when they cover less than lead time + review period.",
        next: p.recommendation ? { label: "Add to Purchasing Cart", action: "add-cart", arg: p.sku } : { label: "View Forecast", action: "view-forecast", arg: p.sku },
        note: thin ? "Not enough sales history to forecast reliably; treat as a watch item." : nearEdge ? `Could be avoided if the delivery arrives at the fast end of its ${one(p.lead_time_std_days)}-day variability.` : undefined,
      });
    }
    // ---- 2. overstock / dead stock / expiry
    if (s.kind === "expiry" || p.excess_capital > 0) {
      const unsold = Math.max(0, p.stock - Math.max(0, p.days_to_expiry ?? 0) * p.daily_forecast);
      const expiryValue = s.kind === "expiry" ? unsold * p.unit_cost : 0;
      const value = Math.max(expiryValue, p.excess_capital);
      const soon = s.kind === "expiry" && (p.days_to_expiry ?? 99) <= 14;
      const sev = ((soon && expiryValue >= 1000 ? "high" : value >= 5000 ? "high" : value >= 1000 ? "medium" : "low") as Severity);
      out.push({
        id: `overstock-${p.sku}`, type: "overstock", severity: sev, subject: subj(p), source: "calc",
        title: s.kind === "expiry" ? `${int(unsold)} units projected to expire unsold` : `${int(cover)} days of stock on hand`,
        measure: `${int(p.stock)} units · ${int(cover)} days of cover`, leadTime: L,
        evidence: s.kind === "expiry"
          ? [`Earliest batch expires in ${plural(p.days_to_expiry ?? 0, "day")}`, `At ${one(p.daily_forecast)} a day about ${int(p.stock - unsold)} of ${int(p.stock)} sell by then`]
          : [`${int(cover)} days of cover vs a ${int(d.policy.excess_cover_days)}-day ceiling`, `Sells ${one(p.daily_forecast)} a day`],
        impact: s.kind === "expiry" ? `${money(expiryValue)} at cost could be written off` : `${money(p.excess_capital)} of working capital tied up`,
        impactValue: value,
        rule: "High from $5,000 tied up, or from $1,000 that expires within 14 days; medium from $1,000.",
        next: { label: "Open Risk Details", action: "open-risk", arg: `overstock-${p.sku}` },
      });
    }
  }

  // ---- 3. margin erosion (unconfirmed price increases read from documents)
  for (const doc of docs.filter((x) => ["needs_review", "uploaded"].includes(x.state))) {
    for (const l of (doc.lines.length ? doc.lines : []).filter((x) => x.kind === "item" && x.sku && x.fields.unit_cost != null)) {
      const p = d.products.find((x) => x.sku === l.sku);
      const cost = (l.fields.unit_cost as number);
      if (!p || cost <= p.unit_cost * 1.005) continue;
      const before = (p.unit_price - p.unit_cost) / p.unit_price, after = (p.unit_price - cost) / p.unit_price;
      const annual = (cost - p.unit_cost) * p.daily_forecast * 30;
      out.push({
        id: `margin-${p.sku}-${doc.id}`, type: "margin", severity: after < 0.15 ? "high" : after < before - 0.05 ? "medium" : "low",
        subject: subj(p), source: "ai",
        title: `Unit cost ${cents(p.unit_cost)} → ${cents(cost)} if confirmed`,
        measure: `Margin ${pct(before, 0)} → ${pct(after, 0)}`, leadTime: p.lead_time_days,
        evidence: [`Read from ${doc.name} (${l.ref})`, l.conf.unit_cost != null ? `Extractor confidence ${pct(l.conf.unit_cost, 0)}; not yet confirmed` : "Not yet confirmed", `Shelf price stays ${cents(p.unit_price)}`],
        impact: `About ${money(annual)} less gross margin per 30 days at the current sales rate`,
        impactValue: annual,
        rule: "Unconfirmed cost increases from supplier documents. High when the margin would fall below 15%, medium when it drops by more than 5 points.",
        next: { label: "Inspect Supplier Update", action: "open-doc", arg: doc.id },
      });
    }
  }

  // ---- 4. lead-time bottlenecks (per supplier)
  const pend = pendingUpdates(docs);
  for (const s of d.suppliers) {
    const mine = d.products.filter((p) => p.supplier_id === s.supplier_id);
    const crit = mine.filter((p) => p.days_cover_incl_pipeline < p.lead_time_days);
    const notice = pend.find((u) => u.supplier_id === s.supplier_id && u.kind === "lead_time_change");
    const newL = notice?.new_lead_time_days;
    const newly = newL ? mine.filter((p) => p.days_cover_incl_pipeline >= p.lead_time_days && p.days_cover_incl_pipeline < newL) : [];
    if (!crit.length && !notice && s.lead_time_days < 10) continue;
    const sev = ((crit.length >= 2 ? "high" : crit.length || newly.length || notice ? "medium" : "low") as Severity);
    out.push({
      id: `leadtime-${s.supplier_id}`, type: "leadtime", severity: sev, source: notice ? "ai" : "calc",
      subject: { kind: "supplier", id: s.supplier_id, name: s.name, supplier_id: s.supplier_id },
      title: crit.length ? `${plural(crit.length, "product")} can't be restocked in time` : notice ? `Lead time may rise to ${int((newL as number))} days` : `Long lead time of ${int(s.lead_time_days)} days`,
      measure: `${int(s.lead_time_days)} ± ${one(s.lead_time_std_days)} day lead time`, leadTime: s.lead_time_days,
      evidence: [
        ...(crit.length ? [`Short before delivery: ${crit.map((p) => p.name).join(", ")}`] : []),
        ...(notice ? [`${notice.source} says ${int((newL as number))} days (unconfirmed, ${pct(notice.confidence, 0)} confidence)`] : []),
        ...(newly.length ? [`Would newly fall short: ${newly.map((p) => p.name).join(", ")}`] : []),
        `${plural(mine.length, "SKU")} from this supplier`,
      ],
      impact: crit.length ? `${money(crit.reduce((a, p) => a + p.margin_at_risk, 0))} gross margin at risk across its products` : "Longer protection interval needs more safety stock",
      impactValue: crit.reduce((a, p) => a + p.margin_at_risk, 0) + newly.length * 50,
      rule: "High when two or more of the supplier's products run out before a delivery can arrive; medium with one, or with an unconfirmed delay notice.",
      next: notice ? { label: "Inspect Supplier Update", action: "open-doc", arg: notice.doc } : { label: "Open Risk Details", action: "open-risk", arg: `leadtime-${s.supplier_id}` },
    });
  }

  // ---- 5. budget
  if (opt) {
    for (const l of opt.lines.filter((x) => x.status !== "full")) {
      const p = d.products.find((x) => x.sku === l.sku);
      if (!p) continue;
      const sev = ((l.status === "deferred" ? (l.tier === 0 ? "critical" : "high") : "medium") as Severity);
      out.push({
        id: `budget-${l.sku}`, type: "budget", severity: sev, subject: subj(p), source: "calc",
        title: l.status === "deferred" ? "Deferred by the weekly budget" : `Reduced to ${int(l.qty)} of ${int(l.recommended_qty)} units by the budget`,
        measure: `${money(opt.budget)} budget · ${money(opt.unconstrained_spend)} needed`, leadTime: l.lead_time_days,
        evidence: [l.reason, `Priority ${l.priority} of ${opt.lines.length} in the optimizer`],
        impact: l.status === "deferred" ? `${money(l.margin_at_risk_if_deferred)} gross margin at risk` : "No safety stock on this line",
        impactValue: l.margin_at_risk_if_deferred,
        rule: "Critical when the budget defers a product that runs out before delivery; high for other deferrals; medium when a line is reduced.",
        next: { label: "Open Purchasing Cart", action: "go", arg: "cart" },
      });
    }
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.impactValue - a.impactValue);
}
