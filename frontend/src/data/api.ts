/** HTTP access to the FastAPI engine. Every number the UI shows comes through here. */

async function request(path: string, opts: RequestInit = {}) {
  const r = await fetch(path, { ...opts, headers: { Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : `${r.status} ${r.statusText}`);
  return body;
}

const post = (b: unknown) => ({ method: "POST", body: JSON.stringify(b) });

/** The approver identity for gated actions. Kept in memory only (re-entered after a reload). */
export const approver = { key: "", name: "Demo approver" };
const gated = () => ({ "X-Approver-Key": approver.key, "X-Approver-Name": approver.name });

export const fetchDashboard = (): Promise<import("./types.js").Dashboard> => request("/api/dashboard");
export const fetchHealth = () => request("/api/health");

export const fetchForecast = (sku: string, historyDays: number, horizon: number): Promise<import("./types.js").ForecastDetail> => request(`/api/forecast/${encodeURIComponent(sku)}?history_days=${historyDays}&horizon=${horizon}`);

export const optimize = (b: {budget: number, service_level?: number, review_days?: number, lead_time_overrides?: Record<string, number>}): Promise<import("./types.js").Optimization> => request("/api/optimize", post(b));

export const ask = (b: {question: string, sku?: string | null, budget?: number, service_level?: number}): Promise<import("./types.js").AssistantAnswer> => request("/api/assistant", post(b));

export const listPOs = (): Promise<{purchase_orders: import("./types.js").PurchaseOrder[]}> => request("/api/pos");

export const getPO = (id: number): Promise<import("./types.js").PurchaseOrder> => request(`/api/pos/${id}`);

export const createDrafts = (b: {lines: {sku: string, qty: number, recommended_qty: number | null}[], budget: number, note?: string}): Promise<{created: import("./types.js").PurchaseOrder[]}> => request("/api/pos/drafts", post(b));

export const transitionPO = (id: number, action: "submit"|"approve"|"reject"|"return"|"mark_sent"|"acknowledge"|"cancel", note: string = "") => request(`/api/pos/${id}/${action}`, { ...post({ note }), headers: gated() });

export const listUpdates = (includeReverted = false): Promise<{updates: import("./types.js").ConfirmedUpdate[]}> => request(`/api/supplier-updates?include_reverted=${includeReverted}`);

export const confirmUpdates = (updates: object[]) => request("/api/supplier-updates", post({ updates, by: approver.name }));

export const revertUpdate = (id: number) => request(`/api/supplier-updates/${id}`, { method: "DELETE" });

export const dataStatus = (): Promise<import("./types.js").DataStatus> => request("/api/data/status");

export const checkData = (files: Record<string, string>): Promise<import("./types.js").DataCheck> => request("/api/data/check", post({ files }));

export const importData = (files: Record<string, string>) => request("/api/data/import", post({ files }));
export const resetData = () => request("/api/data/reset", { method: "POST" });

/** Demo dispatch through an integration point. The server records it as simulated; nothing is sent. */
export const dispatchPO = (id: number, channel: "email" | "webhook" | "evolus"): Promise<import("./types.js").PurchaseOrder> =>
  request(`/api/pos/${id}/dispatch`, { ...post({ channel, mode: "simulated" }), headers: gated() });
