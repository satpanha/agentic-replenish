import type { APIRequestContext, Page } from "@playwright/test";

export const KEY = { "X-Approver-Key": "demo-approver" };

/** Put the engine back to the bundled sample: no confirmed supplier updates, no purchase orders. */
export async function resetEngine(request: APIRequestContext) {
  const { updates } = await (await request.get("/api/supplier-updates")).json();
  for (const u of updates) await request.delete(`/api/supplier-updates/${u.id}`);
  await request.post("/api/demo/reset", { headers: KEY });
  await request.post("/api/data/reset");
}

/** Collect uncaught page errors and console errors so every test can assert there were none. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

/** Parse "$9,485.80" → 9485.8 */
export const money = (s: string | null) => Number((s || "").replace(/[^0-9.-]/g, ""));
