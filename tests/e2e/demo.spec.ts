/**
 * The hackathon scenario from the Phase 2 brief (§14), end to end in the browser, on shared state.
 */
import { test, expect } from "@playwright/test";
import { KEY, money, resetEngine, watchErrors } from "./helpers.js";

test.beforeAll(async ({ request }) => { await resetEngine(request); });

test("supplier update → risk → forecast → optimize → simulate → cart → PO → approval", async ({ page, request }) => {
  const errors = watchErrors(page);
  const cola = async () => (await (await request.get("/api/dashboard")).json()).products.find((p: { sku: string }) => p.sku === "SKU008");
  const before = await cola();
  expect(before.reasons).not.toContain("STOCKOUT_RISK");

  await test.step("1. receive the supplier update: longer lead time and higher unit cost", async () => {
    await page.goto("/#/inbox");
    await expect(page.getByRole("heading", { name: "Supplier Inbox" })).toBeVisible();
    await page.locator('tr[data-doc="doc-angkor-pl"]').click();
    await expect(page.getByText("Simulated extraction · sample fixture")).toBeVisible();
    await expect(page.locator(".step[aria-current]")).toHaveText(/Needs review/);
  });

  await test.step("2. review the extracted values and confirm", async () => {
    await expect(page.locator(".rline")).toHaveCount(6);
    await expect(page.getByText("No matching product: choose a SKU or exclude this line.")).toBeVisible();
    await expect(page.locator("[data-confirm]")).toBeDisabled(); // the unmatched line blocks confirmation
    await page.locator('[data-include="a5"]').uncheck();
    await page.locator('[data-include="a4"]').uncheck(); // low-confidence case pack: leave it out
    await expect(page.locator("[data-confirm]")).toBeEnabled();
    await page.locator("[data-confirm]").click();
    await expect(page.locator(".page-sub .status")).toHaveText(/Verified/);
    const after = await cola();
    expect(after.unit_cost).toBe(1.36);
    expect(after.lead_time_days).toBe(8);
  });

  await test.step("3. the updated lead time puts Cola at risk", async () => {
    expect((await cola()).reasons).toContain("STOCKOUT_RISK");
    await expect(page.getByText("Now at risk with the confirmed terms")).toBeVisible();
    await page.goto("/#/risk?sku=SKU008");
    const row = page.locator('[data-risk="stockout-SKU008"]');
    await expect(row).toContainText("Critical");
    await expect(row).toContainText("lead 8d");
  });

  await test.step("4. understand demand in the forecast workspace", async () => {
    await page.goto("/#/forecasts?sku=SKU008");
    await expect(page.locator("[data-fc-title]")).toHaveText("Cola 330ml");
    await expect(page.locator(".metrics-table")).toContainText("WAPE");
    await expect(page.locator(".metrics-table")).toContainText("RMSE");
    await expect(page.locator(".chart-legend").first()).toContainText("14-day SMA baseline");
  });

  await test.step("5. optimize purchasing", async () => {
    await page.goto("/#/cart");
    await page.locator("[data-load-plan]").click();
    await expect(page.locator('tr[data-line="SKU008"]')).toBeVisible();
    await expect(page.locator('tr[data-line="SKU008"] td[data-label="Unit cost"]')).toHaveText("$1.36");
  });

  await test.step("6. simulate a lower budget", async () => {
    const full = money(await page.locator(".sim-compare > div:nth-child(3) b").textContent());
    await page.locator('[data-sim-pct="-30"]').click();
    await expect(page.locator(".sim-compare .was")).toBeVisible();
    const lower = money(await page.locator(".sim-compare > div:nth-child(3) b").textContent());
    expect(lower).toBeLessThan(full);
    expect(lower).toBeLessThanOrEqual(12000 * 0.7);
    await page.locator("[data-sim-apply]").click();
    await expect(page.locator(".budget-grid > div:nth-child(1) dd")).toHaveText("$8,400");
  });

  await test.step("7. review reasons and adjust a quantity", async () => {
    await page.locator('[data-why="SKU008"]').click();
    await expect(page.locator(".why-eq")).toContainText("safety stock");
    const qty = page.locator('[data-qty="SKU008"]');
    await qty.fill("500");
    await qty.press("Enter");
    await expect(page.locator("#iss-SKU008 .issue-error")).toContainText("cases of 24");
    await expect(page.locator("[data-generate]")).toBeDisabled();
    await page.locator('#iss-SKU008 [data-fix]').first().click(); // round down to 480
    await expect(qty).toHaveValue("480");
    await expect(page.locator('tr[data-line="SKU008"] td[data-label="Extended"]')).toHaveText("$652.80");
  });

  let created: number[] = [];
  await test.step("8. generate the purchase order drafts", async () => {
    await page.locator("[data-generate]").click();
    await expect(page).toHaveURL(/#\/orders\?created=/);
    created = page.url().split("created=")[1].split(",").map(Number);
    await expect(page.locator(".created-note")).toBeVisible();
    const { purchase_orders } = await (await request.get("/api/pos")).json();
    const angkor = purchase_orders.find((p: { id: number; supplier_id: string }) => created.includes(p.id) && p.supplier_id === "S2");
    expect(angkor.status).toBe("draft");
    expect(angkor.lines.find((l: { sku: string }) => l.sku === "SKU008")).toMatchObject({ qty: 480, unit_cost: 1.36, line_cost: 652.8 });
    await page.locator(`tr[data-po="${angkor.id}"]`).click();
  });

  await test.step("9. human approval: return once for revision, then approve", async () => {
    await expect(page.locator(".po-checks")).toContainText("Ready to approve");
    await page.locator('[data-act="submit"]').click();
    await expect(page.locator(".page-sub .status")).toHaveText(/Pending approval/);
    await page.fill("#ap-key", "demo-approver");
    await page.locator('[data-act="return"]').click();
    await page.locator("[data-confirm]").click();
    await expect(page.locator("#ap-note-err")).toBeVisible(); // a reason is required
    await page.fill("#ap-note", "Confirm Cola quantity with store manager");
    await page.locator("[data-confirm]").click();
    await expect(page.locator(".page-sub .status")).toHaveText(/Draft/);
    await page.locator('[data-act="submit"]').click();
    await page.fill("#ap-key", "demo-approver");
    await page.locator('[data-act="approve"]').click();
    await page.locator("[data-confirm]").click();
    await expect(page.locator(".page-sub .status")).toHaveText(/Approved/);
  });

  await test.step("10. the saved order, its history and a simulated dispatch", async () => {
    await page.locator('[data-dispatch="evolus"]').click();
    await expect(page.getByText("Evolus AI workflow · simulated")).toBeVisible();
    await expect(page.locator(".page-sub .status")).toHaveText(/Approved/); // simulation never marks it sent
    const id = Number(page.url().split("orders/")[1]);
    const po = await (await request.get(`/api/pos/${id}`)).json();
    expect(po.events.map((e: { action: string }) => e.action)).toEqual(["created", "submit", "return", "submit", "approve", "simulated_dispatch"]);
    await page.goto(`/#/orders/${id}/preview`);
    await expect(page.locator(".po-doc")).toContainText("Returned for revision");
    await expect(page.locator(".po-doc")).toContainText("simulated only");
    await page.goto("/#/overview");
    await expect(page.locator(".insight", { hasText: "unit cost rises" })).toHaveCount(0); // confirmed, so no longer pending
  });

  expect(errors).toEqual([]);
  await request.post("/api/demo/reset", { headers: KEY });
});
