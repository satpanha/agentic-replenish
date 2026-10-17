/**
 * Navigation, search, filtering, shared-state consistency, and empty/error states (brief §11-§13).
 */
import { test, expect } from "@playwright/test";
import { money, resetEngine, watchErrors } from "./helpers.js";

test.beforeAll(async ({ request }) => { await resetEngine(request); });

const PAGES: [string, string][] = [
  ["Overview", "Inventory Command Center"], ["Inventory", "Inventory"], ["Demand Forecasts", "Demand Forecasts"],
  ["Risk Radar", "Risk Radar"], ["Supplier Inbox", "Supplier Inbox"], ["Purchasing Cart", "Purchasing Cart"],
  ["Purchase Orders", "Purchase Orders"], ["Settings & Integrations", "Settings & Integrations"],
];

test("every sidebar item opens its page and marks itself active", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  for (const [nav, heading] of PAGES) {
    await page.locator(".nav-link", { hasText: nav }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('.nav-link[aria-current="page"]')).toHaveText(new RegExp(nav.replace("&", "&")));
  }
  expect(errors).toEqual([]);
});

test("global search opens the matching product", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("/");
  await page.keyboard.type("cola");
  await page.keyboard.press("Enter");
  await expect(page.locator("#drawer-title")).toHaveText("Cola 330ml");
});

test("inventory filters, sorting and the empty state", async ({ page }) => {
  await page.goto("/#/inventory");
  await page.locator("#f-category").selectOption("Dairy");
  const rows = page.locator("tbody tr[data-sku]");
  await expect(rows).toHaveCount(6);
  for (const t of await page.locator("tbody td.secondary:nth-child(3)").allTextContents()) expect(t).toBe("Dairy");
  await page.locator('[data-sort="stock"]').click(); // descending first
  const stocks = (await page.locator("tbody tr td:nth-child(4) b").allTextContents()).map(money);
  expect(stocks).toEqual([...stocks].sort((a, b) => b - a));
  await page.locator("[data-inv-q]").fill("no such product");
  await expect(page.getByText("No SKUs match these filters")).toBeVisible();
  await page.locator("[data-clear]").first().click();
  await expect(rows).toHaveCount(15); // first page of 34
});

test("risk radar filters by severity and opens the supporting detail", async ({ page }) => {
  await page.goto("/#/risk");
  await page.locator('[data-sev="critical"]').click();
  const items = page.locator("[data-risk]");
  await expect(items.first()).toBeVisible();
  for (const t of await items.locator(".risk-sev").allTextContents()) expect(t.trim()).toBe("Critical");
  await items.first().click();
  await expect(page.locator(".drawer")).toContainText("Rule applied");
  await page.locator('.drawer [data-action="view-forecast"]').click();
  await expect(page).toHaveURL(/#\/forecasts\?sku=SKU/);
});

test("cart totals equal the sum of line costs and the overview agrees", async ({ page }) => {
  await page.goto("/#/cart");
  await page.locator("[data-load-plan]").click();
  const costs = (await page.locator('td[data-label="Extended"]').allTextContents()).map(money);
  const spend = money(await page.locator(".budget-grid > div:nth-child(2) dd").textContent());
  expect(spend).toBeCloseTo(costs.reduce((a, b) => a + b, 0), 2);
  const util = Number((await page.locator(".budget-grid > div:nth-child(4) dd").textContent())?.replace("%", ""));
  expect(util).toBe(Math.round((spend / 12000) * 100));
  await page.locator("[data-sim-budget]").or(page.locator("#sim-budget")).fill("3000");
  await page.locator("#sim-budget").press("Enter");
  await expect(page.locator(".sim-compare")).toContainText("deferred");
  expect(money(await page.locator(".sim-compare > div:nth-child(3) b").textContent())).toBeLessThanOrEqual(3000);
  await page.goto("/#/overview");
  // the KPI counts up on first load; wait for the settled value
  await expect.poll(async () => money(await page.locator(".metric:nth-child(4) .mv").textContent()))
    .toBe(Math.round(spend)); // the full plan at $12,000 is the unconstrained recommendation
});

test("the forecast horizon is shared with the rest of the app", async ({ page }) => {
  await page.goto("/#/forecasts?sku=SKU032");
  await page.locator('[data-hz="28"]').click();
  await page.goto("/#/inventory");
  await expect(page.locator("thead")).toContainText("Forecast 28d");
});

test("an unreachable engine shows an error state with a retry", async ({ page }) => {
  await page.route("**/api/dashboard", (r) => r.abort());
  await page.goto("/");
  await expect(page.getByText("The inventory engine didn't respond")).toBeVisible();
  await page.unroute("**/api/dashboard");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Inventory Command Center" })).toBeVisible();
});

test("phone layout: no horizontal scrolling on the main pages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["overview", "inventory", "risk", "cart", "orders", "inbox"]) {
    await page.goto(`/#/${route}`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(390);
  }
});
