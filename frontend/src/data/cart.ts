/**
 * Cart arithmetic and validation. Totals are always recomputed from the cart state:
 *   extended cost = final quantity × unit cost;  proposed spend = Σ extended cost.
 * Quantities are never silently rounded; a fix is offered and shown instead.
 */
import { int, money } from "../lib/format.js";
import { forecastUnits, statusOf, supplierMap } from "./model.js";

export type Issue = {code: string, level: "error" | "warning", msg: string, fixes?: {label: string, qty: number}[]};

export function validateQty(p: import("./types.js").Product, qty: number): Issue[] {
  const out: Issue[] = [];
  if (!Number.isFinite(qty) || !Number.isInteger(qty)) return [{ code: "nan", level: "error", msg: "Enter a whole number of units." }];
  if (qty < 0) return [{ code: "neg", level: "error", msg: "Quantity can't be negative.", fixes: [{ label: "Set to 0", qty: 0 }] }];
  if (qty === 0) return [{ code: "zero", level: "warning", msg: "Zero units: this line is left out of the draft." }];
  const pack = p.pack_size;
  const up = Math.ceil(qty / pack) * pack;
  const down = Math.floor(qty / pack) * pack;
  const minValid = Math.ceil(Math.max(p.moq, pack) / pack) * pack;
  if (qty % pack) {
    const fixes: {label: string, qty: number}[] = [];
    if (down >= minValid) fixes.push({ label: `Round down to ${int(down)}`, qty: down });
    fixes.push({ label: `Round up to ${int(Math.max(up, minValid))}`, qty: Math.max(up, minValid) });
    out.push({ code: "pack", level: "error", msg: `Not a whole number of cases: ${p.name} ships in cases of ${pack}.`, fixes });
  }
  if (qty < p.moq) {
    out.push({ code: "moq", level: "error", msg: `Below the minimum order quantity of ${int(p.moq)}.`, fixes: [{ label: `Raise to ${int(minValid)}`, qty: minValid }] });
  }
  return out;
}

/** @param opt optimizer lines by SKU, for reasons */
export function cartSummary(d: import("./types.js").Dashboard, cart: Record<string, import("../state.js").CartLine>, budget: number, opt: Record<string, import("./types.js").OptLine> = {}) {
  const sup = supplierMap(d);
  const by = Object.fromEntries(d.products.map((p) => [p.sku, p]));
  const lines = Object.entries(cart).filter(([sku]) => by[sku]).map(([sku, c]) => {
    const p = by[sku];
    const issues = validateQty(p, c.qty);
    const R = d.policy.review_days;
    return {
      sku, p, line: c, supplier: sup[p.supplier_id], status: statusOf(p), issues, opt: opt[sku] || null,
      cost: c.qty > 0 && Number.isFinite(c.qty) ? Math.round(c.qty * p.unit_cost * 100) / 100 : 0,
      demand: forecastUnits(p, Math.ceil(p.lead_time_days) + R),
      blocking: issues.some((i) => i.level === "error"),
    };
  }).sort((a, b) => a.status.rank - b.status.rank || a.p.name.localeCompare(b.p.name));

  const groups = Object.values(lines.reduce((acc, l) => {
    (acc[l.p.supplier_id] ||= { supplier: l.supplier, lines: ([] as typeof lines), subtotal: 0 }).lines.push(l);
    acc[l.p.supplier_id].subtotal += l.cost;
    return acc;
  }, ({} as Record<string, {supplier: import("./types.js").Supplier, lines: typeof lines, subtotal: number}>))).map((g) => ({
    ...g, subtotal: Math.round(g.subtotal * 100) / 100,
    belowMinimum: g.subtotal > 0 && g.subtotal < g.supplier.min_order_value,
  })).sort((a, b) => b.subtotal - a.subtotal);

  const spend = Math.round(lines.reduce((a, l) => a + l.cost, 0) * 100) / 100;
  const blockers: string[] = [];
  const lineErrors = lines.filter((l) => l.blocking).length;
  if (lineErrors) blockers.push(`${lineErrors} line${lineErrors > 1 ? "s have" : " has"} a quantity that breaks a supplier rule.`);
  if (spend > budget) blockers.push(`Proposed spend is ${money(spend - budget)} over the ${money(budget)} weekly budget.`);
  groups.filter((g) => g.belowMinimum).forEach((g) => blockers.push(`${g.supplier.name}: ${money(g.subtotal)} is below its ${money(g.supplier.min_order_value)} minimum order.`));
  const included = lines.filter((l) => l.line.qty > 0 && !l.blocking);
  return {
    lines, groups, spend, budget, remaining: Math.round((budget - spend) * 100) / 100,
    utilisation: budget > 0 ? spend / budget : null,
    count: lines.filter((l) => l.line.qty > 0).length,
    violations: lineErrors + (spend > budget ? 1 : 0) + groups.filter((g) => g.belowMinimum).length,
    blockers, canGenerate: !blockers.length && included.length > 0, included,
    edited: lines.filter((l) => l.line.edited).length,
  };
}
