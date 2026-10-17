/**
 * Deterministic frontend calculations, run against the engine's real dashboard payload.
 * Covers brief §13 items 1-4 and 6 at the function level; the browser specs cover them on screen.
 */
import { test, expect } from "@playwright/test";
import type { Dashboard, PurchaseOrder } from "../../frontend/src/data/types.js";
import { cartSummary, validateQty } from "../../frontend/src/data/cart.js";
import { poChecks } from "../../frontend/src/data/po.js";
import { pendingUpdates } from "../../frontend/src/data/model.js";
import { INBOX_FIXTURES } from "../../frontend/src/data/demo.js";
import { resetEngine } from "./helpers.js";

let d: Dashboard;
test.beforeAll(async ({ request }) => {
  await resetEngine(request);
  d = await (await request.get("/api/dashboard")).json();
});

const product = (sku: string) => d.products.find((p) => p.sku === sku)!;
const round2 = (n: number) => Math.round(n * 100) / 100;

test("quantity validation follows each product's own case pack and MOQ", () => {
  const peanuts = product("SKU032"); // case 20, MOQ 40
  expect(validateQty(peanuts, 740)).toEqual([]);
  const pack = validateQty(peanuts, 745);
  expect(pack[0].code).toBe("pack");
  expect(pack[0].fixes?.map((f) => f.qty)).toEqual([740, 760]); // never rounded silently: both options offered
  expect(validateQty(peanuts, 20).map((i) => i.code)).toEqual(["moq"]);
  expect(validateQty(peanuts, 0)[0].level).toBe("warning");
  expect(validateQty(peanuts, -20)[0].code).toBe("neg");
  expect(validateQty(peanuts, Number.NaN)[0].code).toBe("nan");
  const cream = product("SKU006"); // different supplier rules: case 6, MOQ 12
  expect(validateQty(cream, 18)).toEqual([]);
  expect(validateQty(cream, 20)[0].code).toBe("pack");
});

test("editing a quantity updates its line cost, the total and utilisation", () => {
  const cart = { SKU032: { qty: 740, rec: 740, edited: false }, SKU033: { qty: 504, rec: 504, edited: false } };
  const before = cartSummary(d, cart, 12000);
  const edited = cartSummary(d, { ...cart, SKU032: { qty: 760, rec: 740, edited: true } }, 12000);
  const line = edited.lines.find((l) => l.sku === "SKU032")!;
  expect(line.cost).toBe(round2(760 * product("SKU032").unit_cost));
  expect(edited.spend).toBe(round2(edited.lines.reduce((a, l) => a + l.cost, 0)));
  expect(edited.spend - before.spend).toBeCloseTo(20 * product("SKU032").unit_cost, 2);
  expect(edited.utilisation).toBeCloseTo(edited.spend / 12000, 10);
  expect(edited.remaining).toBe(round2(12000 - edited.spend));
  expect(edited.edited).toBe(1);
});

test("constraint violations are counted and block draft generation", () => {
  const bad = cartSummary(d, { SKU032: { qty: 745, rec: 740, edited: true } }, 12000);
  expect(bad.violations).toBe(1);
  expect(bad.canGenerate).toBe(false);
  const overBudget = cartSummary(d, { SKU032: { qty: 740, rec: 740, edited: false } }, 1000);
  expect(overBudget.blockers.some((b) => b.includes("over the"))).toBe(true);
  expect(overBudget.canGenerate).toBe(false);
  // Cream alone is $892.80, above Mekong's $150 minimum; one case is below it
  const belowMin = cartSummary(d, { SKU006: { qty: 12, rec: null, edited: true } }, 12000);
  expect(belowMin.blockers.some((b) => b.includes("minimum order"))).toBe(true);
  const ok = cartSummary(d, { SKU032: { qty: 740, rec: 740, edited: false } }, 12000);
  expect(ok.canGenerate).toBe(true);
});

test("purchase order checks catch tampering, broken packs and price drift", () => {
  const p = product("SKU008");
  const po: PurchaseOrder = {
    id: 1, supplier_id: "S2", supplier_name: "Angkor Beverage Co", status: "pending", total_cost: round2(576 * p.unit_cost), lead_time_days: 5,
    lines: [{ sku: "SKU008", name: p.name, qty: 576, unit_cost: p.unit_cost, line_cost: round2(576 * p.unit_cost), pack_size: 24, moq: 48 }],
    warnings: [], rationale: "", created_at: "", created_by: "user", decided_at: null, decided_by: null, updated_at: "", events: [], terms: {},
  };
  expect(poChecks(po, d).blocking).toBe(false);
  expect(poChecks({ ...po, total_cost: po.total_cost + 1 }, d).blocking).toBe(true);
  const broken = { ...po, lines: [{ ...po.lines[0], qty: 570, line_cost: round2(570 * p.unit_cost) }], total_cost: round2(570 * p.unit_cost) };
  expect(poChecks(broken, d).checks.find((c) => c.label === "Whole cases only")?.ok).toBe(false);
  const drift = { ...po, lines: [{ ...po.lines[0], unit_cost: 1.2, line_cost: round2(576 * 1.2) }], total_cost: round2(576 * 1.2) };
  const r = poChecks(drift, d);
  expect(r.blocking).toBe(false); // a warning, not a blocker
  expect(r.checks.find((c) => c.label.startsWith("Prices"))?.ok).toBe(false);
});

test("the demo supplier document reports a longer lead time and a higher unit cost", () => {
  const angkor = pendingUpdates(INBOX_FIXTURES).filter((u) => u.doc === "doc-angkor-pl");
  expect(angkor.map((u) => u.kind).sort()).toEqual(["lead_time_change", "price_change"]);
  const cola = product("SKU008");
  // with today's 5-day lead time Cola is covered; with 8 days it would not be
  expect(cola.days_cover_incl_pipeline).toBeGreaterThan(cola.lead_time_days);
  expect(cola.days_cover_incl_pipeline).toBeLessThan(angkor.find((u) => u.kind === "lead_time_change")!.new_lead_time_days!);
});
