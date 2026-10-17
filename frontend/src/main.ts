/** Boot: shell, router, global actions, drawers, assistant. */
import { $ } from "./lib/dom.js";
import { addToCart, go, load, openAssistant, parseHash, removeFromCart, store } from "./state.js";
import { mountShell } from "./ui/shell.js";
import { closeDrawer, openDrawer, toast } from "./ui/overlay.js";
import { riskDrawer, skuDrawer } from "./ui/details.js";
import { openImport } from "./ui/import-dialog.js";
import { mountAssistant } from "./ui/assistant.js";
import { mountOverview } from "./pages/overview/index.js";
import { mountInventory } from "./pages/inventory.js";
import { mountForecasts } from "./pages/forecasts.js";
import { mountRisk, lastRisks } from "./pages/risk.js";
import { mountInbox } from "./pages/inbox.js";
import { mountCart } from "./pages/cart.js";
import { mountOrders } from "./pages/orders.js";
import { mountSettings } from "./pages/settings.js";
import { enterPage, newPageScope } from "./lib/motion.js";

/** Page registry: one mount function per NAV id. Each returns its unmount. */
const PAGES = (({
  overview: mountOverview,
  inventory: mountInventory,
  forecasts: mountForecasts,
  risk: mountRisk,
  inbox: mountInbox,
  cart: mountCart,
  orders: mountOrders,
  settings: mountSettings,
}) as Record<string, (root: HTMLElement) => () => void>);

mountShell(($("#root") as HTMLElement));
mountAssistant();
const content = ($("#content") as HTMLElement);
let unmount = () => {};
let stopWaiting = () => {};

function route() {
  const { id, sub, params } = parseHash();
  unmount();
  stopWaiting();
  newPageScope(content);
  store.set({ route: id, routeSub: sub, routeParams: params, drawer: null });
  delete content.dataset.scrolled;
  unmount = (PAGES[id] || PAGES.overview)(content);
  if (id !== "overview" || sub) { window.scrollTo(0, 0); content.focus({ preventScroll: true }); }
  // entrance plays once, when the page shows real content (after the first data load if needed)
  if (store.get().data) requestAnimationFrame(() => enterPage(content));
  else stopWaiting = store.subscribe((s, ch) => {
    if (ch.has("status") && s.status !== "loading") { stopWaiting(); stopWaiting = () => {}; requestAnimationFrame(() => enterPage(content)); }
  });
}
window.addEventListener("hashchange", route);
route();

// ---- actions: one vocabulary for buttons, search results, alerts and the assistant -------------

async function run(action: string, arg: string = "") {
  switch (action) {
    case "open-sku": store.set({ drawer: { type: "sku", sku: arg } }); break;
    case "open-risk": store.set({ drawer: { type: "risk", id: arg } }); break;
    case "open-update":
    case "open-doc": store.set({ drawer: null }); go(`inbox/${arg}`); break;
    case "go": store.set({ drawer: null }); go(arg); break;
    case "import": openImport(); break;
    case "ask": openAssistant(arg || null); break;
    case "add-cart": {
      const added = addToCart([arg]);
      toast(added.length ? "Added to the Purchasing Cart" : "Already in the cart", { label: "Review cart", run: () => go(`cart?sku=${arg}`) });
      break;
    }
    case "remove-cart": removeFromCart(arg); toast("Removed from the cart"); break;
    case "view-forecast": store.set({ drawer: null, chartSku: arg }); go(`forecasts?sku=${arg}`); break;
    case "filter-supplier": store.set({ drawer: null }); go(`inventory?supplier=${arg}`); break;
  }
}

document.addEventListener("click", (e) => {
  const t = ((e.target as Element).closest("[data-action]") as HTMLElement | null);
  if (!t) return;
  e.preventDefault();
  run(t.dataset.action || "", t.dataset.arg);
});
document.addEventListener("sp:action", (e) => {
  const { action, arg } = (e as CustomEvent).detail;
  run(action, arg);
});

// ---- drawer follows state ---------------------------------------------------------------------

store.subscribe((s, ch) => {
  if (!ch.has("drawer") && !(s.drawer && (ch.has("cart") || ch.has("data") || ch.has("period") || ch.has("docs")))) return;
  if (!s.drawer || !s.data) return closeDrawer(ch.has("drawer"));
  const dr = s.drawer;
  const view = dr.type === "sku" ? skuDrawer(s.data, dr.sku, s) : (() => { const r = lastRisks.find((x) => x.id === dr.id); return r ? riskDrawer(r) : null; })();
  if (!view) return store.set({ drawer: null });
  const keep = !ch.has("drawer");
  const focusedAction = keep ? (document.activeElement as HTMLElement | null)?.dataset?.action : null;
  openDrawer({ ...view, onClose: () => store.set({ drawer: null }) });
  if (focusedAction) (document.querySelector(`.drawer [data-action^="${focusedAction.split("-")[0]}"]`) as HTMLElement | null)?.focus();
});

load();
