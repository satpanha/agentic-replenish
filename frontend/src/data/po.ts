/**
 * Purchase-order checks run before approval. Pure functions over the PO record and the current
 * engine data, so the same rules can be tested without a browser.
 */
import type { Dashboard, PurchaseOrder } from "./types.js";
import { cents, int } from "../lib/format.js";

export interface PoCheck {
  label: string;
  ok: boolean;
  /** error blocks approval; warning is shown but does not block */
  level: "error" | "warning";
  detail: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function poChecks(po: PurchaseOrder, d: Dashboard | null): { checks: PoCheck[]; blocking: boolean } {
  const checks: PoCheck[] = [];
  const by = new Map((d?.products || []).map((p) => [p.sku, p]));
  const supplier = d?.suppliers.find((s) => s.supplier_id === po.supplier_id);

  const badQty = po.lines.filter((l) => !Number.isInteger(l.qty) || l.qty <= 0);
  checks.push({ label: "Quantities are positive whole units", ok: !badQty.length, level: "error",
    detail: badQty.length ? badQty.map((l) => l.name).join(", ") : `${po.lines.length} line${po.lines.length === 1 ? "" : "s"}` });

  const packIssues = po.lines.filter((l) => {
    const pack = l.pack_size ?? by.get(l.sku)?.pack_size;
    return pack ? l.qty % pack !== 0 : false;
  });
  checks.push({ label: "Whole cases only", ok: !packIssues.length, level: "error",
    detail: packIssues.length ? packIssues.map((l) => `${l.name}: ${int(l.qty)} is not a multiple of ${l.pack_size ?? by.get(l.sku)?.pack_size}`).join("; ") : "Every line is a multiple of its case pack" });

  const moqIssues = po.lines.filter((l) => {
    const moq = l.moq ?? by.get(l.sku)?.moq;
    return moq ? l.qty < moq : false;
  });
  checks.push({ label: "Minimum order quantities met", ok: !moqIssues.length, level: "error",
    detail: moqIssues.length ? moqIssues.map((l) => `${l.name}: ${int(l.qty)} < MOQ ${int(l.moq ?? by.get(l.sku)?.moq ?? 0)}`).join("; ") : "All lines at or above MOQ" });

  const arith = po.lines.filter((l) => round2(l.qty * l.unit_cost) !== round2(l.line_cost));
  const sum = round2(po.lines.reduce((a, l) => a + l.line_cost, 0));
  checks.push({ label: "Line totals and order total add up", ok: !arith.length && sum === round2(po.total_cost), level: "error",
    detail: arith.length ? `Line total mismatch on ${arith.map((l) => l.name).join(", ")}` : sum === round2(po.total_cost) ? `Σ lines = ${cents(sum)}` : `Σ lines ${cents(sum)} ≠ total ${cents(po.total_cost)}` });

  if (supplier) {
    const ok = po.total_cost >= supplier.min_order_value;
    checks.push({ label: "Supplier minimum order value", ok, level: "error",
      detail: ok ? `${cents(po.total_cost)} ≥ ${cents(supplier.min_order_value)}` : `${cents(po.total_cost)} is below ${cents(supplier.min_order_value)}` });
  }

  const drift = po.lines.filter((l) => {
    const p = by.get(l.sku);
    return p && round2(p.unit_cost) !== round2(l.unit_cost);
  });
  checks.push({ label: "Prices match trusted supplier data", ok: !drift.length, level: "warning",
    detail: drift.length
      ? drift.map((l) => `${l.name}: drafted at ${cents(l.unit_cost)}, trusted cost is now ${cents(by.get(l.sku)!.unit_cost)}`).join("; ") + ". Return for revision to reprice."
      : d ? "Unit prices equal the current trusted costs" : "Engine data not loaded" });

  return { checks, blocking: checks.some((c) => !c.ok && c.level === "error") };
}

/** What the dispatch column says, derived only from recorded actions. */
export function dispatchState(po: PurchaseOrder): string {
  if (po.status === "acknowledged") return "Supplier confirmed (recorded)";
  if (po.status === "sent") return "Sent (recorded by you)";
  if (po.status === "approved") return po.dispatch?.length ? "Ready · simulated dispatch only" : "Ready to dispatch";
  return "-";
}
