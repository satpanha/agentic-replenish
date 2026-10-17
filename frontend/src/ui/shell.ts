/** Application shell: sidebar, top bar, global search, menus. Rendered once, then updated. */
import { $, $$, html, on, setHTML } from "../lib/dom.js";
import { brandMark, icon } from "../lib/icons.js";
import { clock, shortDate, parseDay, addDays } from "../lib/format.js";
import { NAV } from "../config.js";
import { USER, WORKSPACE } from "../data/demo.js";
import { insights, pendingUpdates, statusOf } from "../data/model.js";
import { cartCount, go, load, openAssistant, store } from "../state.js";
import { bindPopover, closePopover, toast } from "./overlay.js";
import { severityIcon } from "./status.js";

export function mountShell(root: HTMLElement) {
  const groups = [...new Set(NAV.map((n) => n.group))];
  setHTML(root, html`
    <a class="skip-link" href="#content">Skip to content</a>
    <div class="app" id="app">
      <aside class="sidebar" id="sidebar" aria-label="Primary">
        <a class="brand" href="#/overview" aria-label="StockPulse AMD, Overview">${brandMark()}<span class="brand-name">StockPulse<span>AMD</span></span></a>
        <nav class="nav" aria-label="Main">
          ${groups.map((g, i) => html`
            ${i ? html`<div class="nav-group">${g}</div>` : ""}
            ${NAV.filter((n) => n.group === g).map((n) => html`
              <a class="nav-link" href="#/${n.id}" data-route="${n.id}" title="${n.label}">
                ${icon(n.icon)}<span class="label">${n.label}</span>
                ${n.id === "cart" ? html`<span class="badge" data-cart-badge hidden></span>` : ""}
              </a>`)}`)}
        </nav>
        <div class="sidebar-foot">
          <div class="engine-note">
            <span class="prov prov-calc">Calculated: forecasts, orders</span>
            <span class="prov prov-ai">AI on AMD: supplier documents</span>
          </div>
          <button class="btn btn-ghost collapse-btn" type="button" data-collapse aria-controls="sidebar">${icon("panel")}<span class="label">Collapse sidebar</span></button>
        </div>
      </aside>
      <div class="nav-scrim" data-nav-scrim hidden></div>

      <div class="main">
        <header class="topbar">
          <button class="btn btn-icon menu-toggle" type="button" data-menu aria-controls="sidebar" aria-label="Open navigation">${icon("menu")}</button>
          <div class="pop-anchor">
            <button class="workspace-btn" type="button" data-ws aria-haspopup="menu" aria-label="Workspace: ${WORKSPACE.name}">
              <span class="ws-avatar" aria-hidden="true">${WORKSPACE.initials}</span>
              <span class="ws-text"><strong>${WORKSPACE.name}</strong><small>${WORKSPACE.kind}</small></span>
              ${icon("chevronDown", "icon-xs")}
            </button>
            <div class="pop pop-left" role="menu" data-ws-pop hidden></div>
          </div>
          <span class="divider" aria-hidden="true"></span>
          <div class="global-search search-field pop-anchor">
            ${icon("search", "icon-sm")}
            <input class="input" id="global-search" type="search" autocomplete="off" placeholder="Search SKUs, suppliers, pages"
              role="combobox" aria-expanded="false" aria-controls="search-results" aria-autocomplete="list" aria-label="Search">
            <span class="kbd" aria-hidden="true">/</span>
            <div class="pop" id="search-results" role="listbox" aria-label="Search results" hidden></div>
          </div>
          <div class="topbar-right">
            <button class="sync" type="button" data-sync aria-live="polite"></button>
            <span class="divider" aria-hidden="true"></span>
            <div class="pop-anchor">
              <button class="btn btn-icon bell" type="button" data-bell aria-haspopup="true" aria-label="Notifications">${icon("bell")}<span class="pip" data-pip hidden></span></button>
              <div class="pop pop-right" style="width:340px" data-bell-pop hidden></div>
            </div>
            <button class="btn btn-secondary ask-btn" type="button" data-ask aria-label="Open the procurement assistant">${icon("scan", "icon-sm")}<span class="label">Assistant</span></button>
            <button class="btn btn-primary import-btn" type="button" data-action="import">${icon("upload", "icon-sm")}<span class="label">Import Data</span></button>
            <div class="pop-anchor">
              <button class="avatar-btn" type="button" data-user aria-haspopup="menu" aria-label="Account: ${USER.name}">${USER.initials}</button>
              <div class="pop pop-right" role="menu" data-user-pop hidden></div>
            </div>
          </div>
        </header>
        <main id="content" class="content" tabindex="-1"></main>
      </div>
    </div>`);

  const app = (($("#app", root)) as HTMLElement);

  // sidebar collapse / mobile drawer
  $("[data-collapse]", root)?.addEventListener("click", () => store.set({ collapsed: !store.get().collapsed }));
  $("[data-menu]", root)?.addEventListener("click", () => store.set({ navOpen: true }));
  $("[data-nav-scrim]", root)?.addEventListener("click", () => store.set({ navOpen: false }));
  on(root, "click", ".nav-link", () => store.set({ navOpen: false }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && store.get().navOpen) store.set({ navOpen: false });
  });

  // menus
  const ws = (($("[data-ws]", root)) as HTMLElement);
  const wsPop = (($("[data-ws-pop]", root)) as HTMLElement);
  bindPopover(ws, wsPop, () => setHTML(wsPop, html`
    <div class="pop-head">Workspaces</div>
    <button class="menu-item" role="menuitemradio" aria-checked="true" type="button" data-close-pop>
      ${icon("store")}<span class="menu-item-stack"><span>${WORKSPACE.name}</span><small>${WORKSPACE.kind} · sample data</small></span><span class="meta">${icon("check", "icon-sm")}</span>
    </button>
    <div class="pop-sep"></div>
    <button class="menu-item" role="menuitem" type="button" disabled>${icon("plus")}<span>Add a store</span><span class="meta">Phase 2</span></button>`));

  const user = (($("[data-user]", root)) as HTMLElement);
  const userPop = (($("[data-user-pop]", root)) as HTMLElement);
  bindPopover(user, userPop, () => setHTML(userPop, html`
    <div class="pop-head">${USER.name} · ${USER.role}</div>
    <button class="menu-item" role="menuitem" type="button" data-go="settings">${icon("settings")}<span>Settings & Integrations</span></button>
    <a class="menu-item" role="menuitem" href="/console">${icon("external")}<span>Classic console</span><span class="meta">Agent run</span></a>
    <div class="pop-sep"></div>
    <button class="menu-item" role="menuitem" type="button" disabled>${icon("logout")}<span>Sign out</span><span class="meta">Demo session</span></button>`));

  const bell = (($("[data-bell]", root)) as HTMLElement);
  const bellPop = (($("[data-bell-pop]", root)) as HTMLElement);
  bindPopover(bell, bellPop, () => {
    const d = store.get().data;
    const list = d ? insights(d, pendingUpdates(store.get().docs)).filter((i) => i.severity !== "info") : [];
    setHTML(bellPop, html`
      <div class="pop-head">${list.length ? `${list.length} alerts need a look` : "No alerts"}</div>
      ${list.map((i) => html`
        <button class="menu-item" role="menuitem" type="button" data-action="${i.cta.action}" data-arg="${i.cta.arg || ""}" style="align-items:flex-start">
          <span class="insight-icon status status-${i.severity === "critical" ? "critical" : "warning"}" style="padding:0;width:22px;justify-content:center">${severityIcon(i.severity)}</span>
          <span class="menu-item-stack"><span>${i.title}</span><small>${i.subject}</small></span>
        </button>`)}`);
  });
  on(root, "click", "[data-close-pop]", () => closePopover(true));
  on(root, "click", "[data-go]", (_e, t) => { closePopover(); go(t.dataset.go || "overview"); });

  // sync: re-runs the engine
  $("[data-sync]", root)?.addEventListener("click", async () => {
    const ok = await load();
    toast(ok ? "Engine recalculated from the latest data" : "Couldn't reach the engine. Showing the last result.");
  });

  $("[data-ask]", root)?.addEventListener("click", () => {
    const s = store.get();
    s.assistant.open ? store.set({ assistant: { ...s.assistant, open: false } }) : openAssistant(s.drawer?.type === "sku" ? s.drawer.sku : null);
  });

  mountSearch(root);

  const update = (s: import("../state.js").AppState) => {
    app.dataset.collapsed = String(s.collapsed);
    app.dataset.navOpen = String(s.navOpen);
    (($("[data-nav-scrim]", root)) as HTMLElement).hidden = !s.navOpen;
    const cb = (($("[data-collapse]", root)) as HTMLElement);
    cb.setAttribute("aria-expanded", String(!s.collapsed));
    cb.setAttribute("aria-label", s.collapsed ? "Expand sidebar" : "Collapse sidebar");
    $$(".nav-link", root).forEach((a) => {
      if (a.dataset.route === s.route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const n = cartCount();
    const badge = (($("[data-cart-badge]", root)) as HTMLElement);
    badge.hidden = !n;
    badge.textContent = String(n);
    badge.setAttribute("aria-label", `${n} lines staged`);
    (($("[data-ask]", root)) as HTMLElement).setAttribute("aria-expanded", String(s.assistant.open));
    (($("[data-pip]", root)) as HTMLElement).hidden = !(s.data && s.data.products.some((p) => statusOf(p).level === "critical"));
    renderSync((($("[data-sync]", root)) as HTMLElement), s);
  };
  store.subscribe(update);
  update(store.get());
}

function renderSync(el: HTMLElement, s: import("../state.js").AppState) {
  el.classList.toggle("is-busy", s.refreshing || s.status === "loading");
  el.classList.toggle("is-error", s.status === "error" || !!(s.error && s.data));
  if (s.status === "loading") {
    setHTML(el, html`${icon("refresh")}<span class="label">Syncing…</span>`);
    el.title = "Loading the engine";
    return;
  }
  if (!s.data || !s.fetchedAt) {
    setHTML(el, html`<span class="dot"></span><span class="label">Engine offline</span>`);
    el.title = "Retry";
    return;
  }
  const through = shortDate(addDays(parseDay(s.data.as_of), -1));
  setHTML(el, s.refreshing
    ? html`${icon("refresh")}<span class="label">Recalculating…</span>`
    : html`<span class="dot dot-live"></span><span class="label">Synced ${clock(s.fetchedAt)} · sales through ${through}</span>`);
  el.title = `Recalculate now. Engine run at ${s.fetchedAt.toLocaleString()}; ${s.data.is_sample_data ? "sample" : "imported"} sales data through ${through}.`;
}

/** 0 = name starts with q, 1 = a word starts with q, 2 = anywhere. */
const rank = (name: string, q: string) => { const n = name.toLowerCase(); return n.startsWith(q) ? 0 : new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n) ? 1 : 2; };

/** Global search: products, suppliers and pages, as an ARIA combobox. */
function mountSearch(root: HTMLElement) {
  const input = (($("#global-search", root)) as HTMLInputElement);
  const box = (($("#search-results", root)) as HTMLElement);
  let results: {label: string, sub: string, action: string, arg: string, icon: import("../lib/icons.js").IconName}[] = [];
  let active = -1;

  const close = () => { box.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; };
  const paint = () => {
    setHTML(box, results.length
      ? html`${results.map((r, i) => html`
          <div class="menu-item" role="option" id="sr-${i}" aria-selected="${i === active}" data-i="${i}">
            ${icon(r.icon)}<span class="menu-item-stack"><span>${r.label}</span><small>${r.sub}</small></span>
          </div>`)}`
      : html`<div class="pop-head" style="padding:12px">No SKU, supplier or page matches “${input.value}”.</div>`);
    if (active >= 0) input.setAttribute("aria-activedescendant", `sr-${active}`);
    else input.removeAttribute("aria-activedescendant");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const search = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return close();
    const d = store.get().data;
    results = [
      ...(d ? d.products.filter((p) => `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(q))
        .sort((a, b) => rank(a.name, q) - rank(b.name, q)).slice(0, 6).map((p) => ({
        label: p.name, sub: `${p.sku} · ${p.category} · ${statusOf(p).label}`, action: "open-sku", arg: p.sku, icon: ("package" as const) })) : []),
      ...(d ? d.suppliers.filter((s) => s.name.toLowerCase().includes(q)).map((s) => ({
        label: s.name, sub: `Supplier · ${d.products.filter((p) => p.supplier_id === s.supplier_id).length} SKUs · ${s.lead_time_days}-day lead time`, action: "filter-supplier", arg: s.supplier_id, icon: ("truck" as const) })) : []),
      ...NAV.filter((n) => n.label.toLowerCase().includes(q)).map((n) => ({
        label: n.label, sub: "Page", action: "go", arg: n.id, icon: n.icon })),
    ];
    active = results.length ? 0 : -1;
    paint();
  };
  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    close();
    input.value = "";
    input.blur();
    document.dispatchEvent(new CustomEvent("sp:action", { detail: { action: r.action, arg: r.arg } }));
  };

  input.addEventListener("input", search);
  input.addEventListener("focus", () => { if (input.value) search(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      paint();
      e.preventDefault();
    } else if (e.key === "Enter") { choose(active); e.preventDefault(); }
    else if (e.key === "Escape") { close(); input.value = ""; }
  });
  box.addEventListener("mousedown", (e) => {
    const t = ((e.target as Element).closest("[data-i]") as HTMLElement | null);
    if (t) { e.preventDefault(); choose(Number(t.dataset.i)); }
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  document.addEventListener("keydown", (e) => {
    const t = (e.target as HTMLElement);
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); input.focus(); }
  });
}
