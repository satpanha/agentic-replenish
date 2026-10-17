/** Application state and the actions every component may call. */
import { createStore, persist } from "./lib/store.js";
import { fetchDashboard, fetchHealth } from "./data/api.js";
import { DEFAULT_ROUTE, NAV } from "./config.js";
import { INBOX_FIXTURES, WEEKLY_BUDGET } from "./data/demo.js";

export type CartLine = {qty: number, rec: number | null, edited: boolean};
export type Settings = {budget: number};
export interface AppState {
  /** first hash segment, a NAV id */
  route: string;
  /** rest of the path, e.g. "12/preview" */
  routeSub: string;
  routeParams: Record<string, string>;
  status: "loading" | "ready" | "error";
  error: string;
  data: import("./data/types.js").Dashboard | null;
  health: {llm_enabled: boolean, model: string | null, data_source: string, confirmed_updates: number} | null;
  fetchedAt: Date | null;
  refreshing: boolean;
  period: import("./data/types.js").Period;
  filter: string;
  category: string;
  query: string;
  sort: import("./data/model.js").Sort;
  showAll: boolean;
  selection: string[];
  cart: Record<string, CartLine>;
  settings: Settings;
  docs: import("./data/types.js").InboxDoc[];
  chartSku: string | null;
  collapsed: boolean;
  navOpen: boolean;
  drawer: null | {type: "sku", sku: string} | {type: "risk", id: string};
  assistant: {open: boolean, sku: string | null, seed: string};
}

/** Phase 1 stored cart lines as bare quantities; lift them to CartLine. */
function readCart() {
  const raw = persist.read<Record<string, number | CartLine>>("sp.cart", {});
  const out: Record<string, CartLine> = {};
  for (const [sku, v] of Object.entries(raw)) {
    out[sku] = typeof v === "number" ? { qty: v, rec: v, edited: false } : v;
  }
  return out;
}

const initial: AppState = {
  route: DEFAULT_ROUTE,
  routeSub: "",
  routeParams: {},
  status: "loading",
  error: "",
  data: null,
  health: null,
  fetchedAt: null,
  refreshing: false,
  period: persist.read("sp.period", 14),
  filter: "attention",
  category: "all",
  query: "",
  sort: { key: "priority", dir: 1 },
  showAll: false,
  selection: [],
  cart: readCart(),
  settings: { budget: WEEKLY_BUDGET, ...persist.read("sp.settings", {}) },
  docs: persist.read("sp.docs.v2", INBOX_FIXTURES),
  chartSku: null,
  collapsed: persist.read("sp.collapsed", false),
  navOpen: false,
  drawer: null,
  assistant: { open: false, sku: null, seed: "" },
};

export const store = createStore(initial);

store.subscribe((s, changed) => {
  if (changed.has("cart")) persist.write("sp.cart", s.cart);
  if (changed.has("collapsed")) persist.write("sp.collapsed", s.collapsed);
  if (changed.has("period")) persist.write("sp.period", s.period);
  if (changed.has("settings")) persist.write("sp.settings", s.settings);
  if (changed.has("docs")) persist.write("sp.docs.v2", s.docs);
});

// ---- data -------------------------------------------------------------------------------------

export async function load() {
  const first = !store.get().data;
  store.set(first ? { status: "loading", error: "" } : { refreshing: true });
  try {
    const [data, health] = await Promise.all([fetchDashboard(), fetchHealth().catch(() => null)]);
    const s = store.get();
    // drop cart lines for SKUs that no longer exist (e.g. after an import)
    const cart = Object.fromEntries(Object.entries(s.cart).filter(([sku]) => data.products.some((p) => p.sku === sku)));
    store.set({ data, health, status: "ready", error: "", fetchedAt: new Date(), refreshing: false, cart });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    store.set(first ? { status: "error", error: msg, refreshing: false } : { refreshing: false, error: msg });
    return false;
  }
}

// ---- routing ----------------------------------------------------------------------------------

export function parseHash() {
  const [path, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [id, ...rest] = path.split("/");
  const params = Object.fromEntries(new URLSearchParams(qs));
  return NAV.some((n) => n.id === id) ? { id, sub: rest.join("/"), params } : { id: DEFAULT_ROUTE, sub: "", params: {} };
}

/** @param path e.g. "orders/12" or "forecasts?sku=SKU032" */
export function go(path: string) {
  if (location.hash !== `#/${path}`) location.hash = `#/${path}`;
  store.set({ navOpen: false });
}

// ---- cart -------------------------------------------------------------------------------------

/** Smallest valid order for a product: one case, at least the MOQ. */
export const minimumOrder = (p: import("./data/types.js").Product) => Math.ceil(Math.max(p.moq, p.pack_size) / p.pack_size) * p.pack_size;

/**
 * Stage products. Uses the engine's recommendation, or the smallest valid order when there is none.
 * Returns the SKUs actually added.
 */
export function addToCart(skus: string[]) {
  const { data, cart } = store.get();
  if (!data) return [];
  const next = { ...cart };
  const added = [];
  for (const sku of skus) {
    const p = data.products.find((x) => x.sku === sku);
    if (!p || next[sku]) continue;
    const rec = p.recommendation?.qty ?? null;
    next[sku] = { qty: rec ?? minimumOrder(p), rec, edited: false };
    added.push(sku);
  }
  store.set({ cart: next });
  return added;
}

export function removeFromCart(sku: string) {
  const next = { ...store.get().cart };
  delete next[sku];
  store.set({ cart: next });
}

export function setCartQty(sku: string, qty: number) {
  const line = store.get().cart[sku];
  if (!line) return;
  store.set({ cart: { ...store.get().cart, [sku]: { ...line, qty, edited: line.rec == null ? true : qty !== line.rec } } });
}

/** Replace the cart with optimizer output. */
export function loadCart(lines: {sku: string, qty: number, recommended_qty: number}[]) {
  const next: Record<string, CartLine> = {};
  for (const l of lines) if (l.qty > 0) next[l.sku] = { qty: l.qty, rec: l.qty, edited: false };
  store.set({ cart: next });
}

export const cartCount = () => Object.keys(store.get().cart).length;

// ---- inbox ------------------------------------------------------------------------------------

export function updateDoc(id: string, patch: Partial<import("./data/types.js").InboxDoc>) {
  store.set({ docs: store.get().docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
}

// ---- assistant --------------------------------------------------------------------------------

export function openAssistant(sku: string | null = null, seed: string = "") {
  store.set({ assistant: { open: true, sku, seed } });
}
