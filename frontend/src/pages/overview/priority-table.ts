/** C: Priority Purchasing Table. The panel frame renders once; rows, filters and footer update. */
import { $, $$, html, on, setHTML } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { cents, int, money, one, plural } from "../../lib/format.js";
import { FILTERS, forecastUnits, levelCounts, statusOf, supplierMap, tableRows } from "../../data/model.js";
import { addToCart, cartCount, go, removeFromCart, store } from "../../state.js";
import { statusBadge } from "../../ui/status.js";
import { toast } from "../../ui/overlay.js";

const PAGE = 8;

const COLS: {key: import("../../data/model.js").SortKey, label: string, num?: boolean}[] = [
  { key: "name", label: "Product" },
  { key: "stock", label: "Stock", num: true },
  { key: "dos", label: "Days of supply" },
  { key: "forecast", label: "Forecast", num: true },
  { key: "lead", label: "Lead time", num: true },
  { key: "qty", label: "Reorder qty", num: true },
  { key: "cost", label: "Est. cost", num: true },
  { key: "status", label: "Risk status" },
];

export function mountPriorityTable(el: HTMLElement) {
  const s0 = store.get();
  const d0 = (s0.data as import("../../data/types.js").Dashboard);
  const categories = [...new Set(d0.products.map((p) => p.category))].sort();

  setHTML(el, html`
    <div class="panel-head">
      <div>
        <h2 class="panel-title" id="pt-title">Priority purchasing</h2>
        <p class="panel-sub">Stockouts first, then this cycle's reorders, expiry and excess. Select a row for the full calculation.</p>
      </div>
      <button class="btn btn-primary" type="button" data-review>${icon("cart", "icon-sm")}Review Purchasing Cart<span class="count num" data-cart-count></span></button>
    </div>
    <div class="toolbar" role="group" aria-label="Table filters">
      <div class="search-field">
        ${icon("search", "icon-sm")}
        <input class="input" type="search" data-q placeholder="Filter by product, SKU or supplier" aria-label="Filter table" value="${s0.query}">
      </div>
      <div class="segmented" role="radiogroup" aria-label="Risk filter" data-filters></div>
      <select class="select" data-cat aria-label="Category">
        <option value="all">All categories</option>
        ${categories.map((c) => html`<option value="${c}">${c}</option>`)}
      </select>
      <span class="spacer"></span>
    </div>
    <div class="selection-bar" data-sel hidden></div>
    <div class="table-wrap">
      <table class="ptable" aria-labelledby="pt-title">
        <thead><tr>
          <th scope="col"><input type="checkbox" class="checkbox" data-all aria-label="Select all visible rows"></th>
          ${COLS.map((c) => html`<th scope="col" class="${c.num ? "r" : ""}" data-col="${c.key}"><button class="sort-btn" type="button" data-sort="${c.key}">${c.label}<span data-unit="${c.key}"></span>${icon("arrowUp")}</button></th>`)}
          <th scope="col" class="r"><span class="visually-hidden">Action</span></th>
        </tr></thead>
        <tbody data-tbody></tbody>
      </table>
    </div>
    <ul class="plist" data-plist aria-label="Priority purchasing"></ul>
    <div class="table-foot" data-foot></div>`);

  const q = (($("[data-q]", el)) as HTMLInputElement);
  q.addEventListener("input", () => store.set({ query: q.value, showAll: false }));
  const cat = (($("[data-cat]", el)) as HTMLSelectElement);
  cat.value = s0.category;
  cat.addEventListener("change", () => store.set({ category: cat.value, showAll: false }));
  on(el, "click", "[data-filter]", (_e, t) => store.set({ filter: t.dataset.filter || "attention", showAll: false, selection: [] }));
  on(el, "keydown", "[data-filter]", (e, t) => {
    const k = (e as KeyboardEvent).key;
    if (k !== "ArrowRight" && k !== "ArrowLeft") return;
    const i = FILTERS.findIndex((f) => f.id === t.dataset.filter);
    const n = FILTERS[(i + (k === "ArrowRight" ? 1 : -1) + FILTERS.length) % FILTERS.length];
    store.set({ filter: n.id, showAll: false, selection: [] });
    (($(`[data-filter="${n.id}"]`, el)) as HTMLElement | null)?.focus();
  });
  on(el, "click", "[data-sort]", (_e, t) => {
    const key = (t.dataset.sort as import("../../data/model.js").SortKey);
    const cur = store.get().sort;
    const firstDir = key === "name" || key === "dos" || key === "lead" ? 1 : -1;
    store.set({ sort: cur.key === key ? (cur.dir === firstDir ? { key, dir: (-firstDir as 1|-1) } : { key: "priority", dir: 1 }) : { key, dir: firstDir } });
  });
  on(el, "click", "[data-review]", () => go("cart"));
  on(el, "click", "[data-more]", () => store.set({ showAll: !store.get().showAll }));

  // selection
  on(el, "change", "[data-pick]", (_e, t) => {
    const sku = (t.dataset.pick as string);
    const sel = new Set(store.get().selection);
    (t as HTMLInputElement).checked ? sel.add(sku) : sel.delete(sku);
    store.set({ selection: [...sel] });
  });
  on(el, "change", "[data-all]", (_e, t) => {
    const visible = $$("[data-pick]", el).filter((x) => x.closest(".table-wrap")).map((x) => (x.dataset.pick as string));
    store.set({ selection: (t as HTMLInputElement).checked ? visible : [] });
  });
  on(el, "click", "[data-sel-add]", () => {
    const added = addToCart(store.get().selection);
    const skipped = store.get().selection.length - added.length;
    store.set({ selection: [] });
    toast(`${plural(added.length, "line")} added to the cart${skipped ? ` · ${skipped} without a recommendation skipped` : ""}`, { label: "Review cart", run: () => go("cart") });
  });
  on(el, "click", "[data-sel-clear]", () => store.set({ selection: [] }));

  // row actions
  on(el, "click", "[data-add]", (e, t) => {
    e.stopPropagation();
    const sku = (t.dataset.add as string);
    if (store.get().cart[sku]) { removeFromCart(sku); toast("Removed from the cart"); return; }
    addToCart([sku]);
    toast("Added to the Purchasing Cart", { label: "Review cart", run: () => go("cart") });
  });
  on(el, "click", "tbody tr[data-sku], .prow-head", (e, t) => {
    if ((e.target as Element).closest("input, button:not(.prow-head), a")) return;
    document.dispatchEvent(new CustomEvent("sp:action", { detail: { action: "open-sku", arg: t.dataset.sku } }));
  });
  on(el, "keydown", "tbody tr[data-sku]", (e, t) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" || k === " ") {
      if (e.target !== t) return;
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("sp:action", { detail: { action: "open-sku", arg: t.dataset.sku } }));
    }
    if (k === "ArrowDown" || k === "ArrowUp") {
      const sib = ((k === "ArrowDown" ? t.nextElementSibling : t.previousElementSibling) as HTMLElement | null);
      sib?.focus();
      e.preventDefault();
    }
  });

  const update = (s: import("../../state.js").AppState) => paint(el, s);
  update(store.get());
  return store.subscribe((s, ch) => {
    if (["data", "query", "filter", "category", "sort", "showAll", "selection", "cart", "period"].some((k) => ch.has(k as keyof import("../../state.js").AppState))) update(s);
  });
}

function paint(el: HTMLElement, s: import("../../state.js").AppState) {
  const d = (s.data as import("../../data/types.js").Dashboard);
  const sup = supplierMap(d);
  const counts = levelCounts(d);
  const rows = tableRows(d, s);
  const shown = s.showAll ? rows : rows.slice(0, PAGE);
  const sel = new Set(s.selection);

  setHTML((($("[data-filters]", el)) as HTMLElement), html`${FILTERS.map((f) => html`
    <button type="button" role="radio" aria-checked="${s.filter === f.id}" tabindex="${s.filter === f.id ? 0 : -1}" data-filter="${f.id}">${f.label}<span class="n num">${counts[f.id]}</span></button>`)}`);

  const n = cartCount();
  const cc = (($("[data-cart-count]", el)) as HTMLElement);
  cc.textContent = String(n);
  cc.hidden = !n;

  $$("th[data-col]", el).forEach((th) => {
    if (th.dataset.col === s.sort.key) th.setAttribute("aria-sort", s.sort.dir === 1 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
  setHTML((($('[data-unit="forecast"]', el)) as HTMLElement), html` · ${s.period}d`);

  const all = (($("[data-all]", el)) as HTMLInputElement);
  const visibleSel = shown.filter((p) => sel.has(p.sku)).length;
  all.checked = shown.length > 0 && visibleSel === shown.length;
  all.indeterminate = visibleSel > 0 && visibleSel < shown.length;

  const selBar = (($("[data-sel]", el)) as HTMLElement);
  selBar.hidden = !sel.size;
  if (sel.size) {
    const withRec = d.products.filter((p) => sel.has(p.sku) && p.recommendation && !s.cart[p.sku]);
    setHTML(selBar, html`<strong>${plural(sel.size, "row")} selected</strong>
      <span>${withRec.length ? `${plural(withRec.length, "recommended line")}, ${money(withRec.reduce((a, p) => a + (p.recommendation?.line_cost || 0), 0))}` : "No new recommended lines in the selection"}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn btn-sm btn-primary" type="button" data-sel-add ${withRec.length ? "" : "disabled"}>${icon("plus", "icon-xs")}Add to cart</button>
      <button class="btn btn-sm btn-ghost" type="button" data-sel-clear>Clear</button>`);
  }

  const tbody = (($("[data-tbody]", el)) as HTMLElement);
  const plist = (($("[data-plist]", el)) as HTMLElement);
  if (!rows.length) {
    const empty = html`<div class="state">${icon("search")}<strong>No products match</strong><span>Try another filter${s.query ? html` or clear “${s.query}”` : ""}.</span>
      <button class="btn btn-secondary btn-sm" type="button" data-reset-filters>Reset filters</button></div>`;
    setHTML(tbody, html`<tr><td colspan="10">${empty}</td></tr>`);
    setHTML(plist, html`<li>${empty}</li>`);
    $$("[data-reset-filters]", el).forEach((b) => b.addEventListener("click", () => {
      (($("[data-q]", el)) as HTMLInputElement).value = "";
      (($("[data-cat]", el)) as HTMLSelectElement).value = "all";
      store.set({ query: "", filter: "all", category: "all" });
    }));
  } else {
    setHTML(tbody, html`${shown.map((p) => row(p, sup[p.supplier_id].name, s, sel.has(p.sku)))}`);
    setHTML(plist, html`${shown.map((p) => card(p, sup[p.supplier_id].name, s, sel.has(p.sku)))}`);
  }

  setHTML((($("[data-foot]", el)) as HTMLElement), html`
    <span>Showing ${shown.length} of ${plural(rows.length, "product")}${rows.length > PAGE ? html` · <button class="btn btn-link" type="button" data-more>${s.showAll ? "Show fewer" : `Show all ${rows.length}`}</button>` : ""}</span>
    <span class="legend-inline">
      <span><span class="legend-tick"></span>Supplier lead time</span>
      <span>Days of supply = (stock + on order) ÷ forecast daily demand</span>
    </span>`);
}

function dosBar(p: import("../../data/types.js").Product) {
  const st = statusOf(p);
  const max = Math.max(p.lead_time_days * 2.5, 21);
  const w = Math.min(100, (100 * p.days_cover_incl_pipeline) / max);
  const t = Math.min(100, (100 * p.lead_time_days) / max);
  const cls = st.level === "critical" ? "is-critical" : st.kind === "reorder" ? "is-warning" : st.level === "healthy" ? "is-healthy" : "";
  return html`<div class="dos ${cls}">
    <div class="dos-text"><b class="num">${p.days_cover_incl_pipeline >= 100 ? int(p.days_cover_incl_pipeline) : one(p.days_cover_incl_pipeline)}d</b><span class="num">${p.days_cover_incl_pipeline > max ? "off scale" : ""}</span></div>
    <div class="meter" aria-hidden="true"><i style="width:${w}%"></i><b style="left:calc(${t}% - 1px)"></b></div>
  </div>`;
}

function row(p: import("../../data/types.js").Product, supplier: string, s: import("../../state.js").AppState, picked: boolean) {
  const r = p.recommendation;
  const inCart = !!s.cart[p.sku];
  return html`<tr data-sku="${p.sku}" tabindex="0" class="${picked ? "is-selected" : ""}" aria-label="${p.name}, ${statusOf(p).label}. Open details">
    <td><input type="checkbox" class="checkbox" data-pick="${p.sku}" aria-label="Select ${p.name}" ${picked ? "checked" : ""}></td>
    <td><div class="prod"><strong>${p.name}</strong><small><span class="mono">${p.sku}</span> · ${supplier}</small></div></td>
    <td class="r num">${int(p.stock)}${p.on_order ? html`<span class="cell-sub">+${int(p.on_order)} on order</span>` : ""}</td>
    <td>${dosBar(p)}</td>
    <td class="r num">${int(forecastUnits(p, s.period))}<span class="cell-sub">${one(p.daily_forecast)}/day</span></td>
    <td class="r num">${int(p.lead_time_days)}d<span class="cell-sub">±${one(p.lead_time_std_days)}</span></td>
    <td class="r num">${r ? html`${int(r.qty)}<span class="cell-sub">${r.qty / p.pack_size} × ${p.pack_size}</span>` : html`<span class="dash" aria-label="None">-</span>`}</td>
    <td class="r num">${r ? money(r.line_cost) : html`<span class="dash" aria-label="None">-</span>`}</td>
    <td>${statusBadge(statusOf(p))}</td>
    <td class="r">${r
      ? html`<button class="btn btn-sm ${inCart ? "is-added" : "btn-secondary"}" type="button" data-add="${p.sku}" aria-pressed="${inCart}" aria-label="${inCart ? `Remove ${p.name} from cart` : `Add ${p.name} to cart`}">${inCart ? html`${icon("check", "icon-xs")}In cart` : html`${icon("plus", "icon-xs")}Add`}</button>`
      : html`<span class="btn btn-sm btn-ghost" aria-hidden="true">Details ${icon("chevronRight", "icon-xs")}</span>`}</td>
  </tr>`;
}

/** Phone layout: the same data, regrouped. */
function card(p: import("../../data/types.js").Product, supplier: string, s: import("../../state.js").AppState, picked: boolean) {
  const r = p.recommendation;
  const inCart = !!s.cart[p.sku];
  return html`<li><div class="prow">
    <input type="checkbox" class="checkbox" data-pick="${p.sku}" aria-label="Select ${p.name}" ${picked ? "checked" : ""} style="margin-top:3px">
    <div class="prow-main">
      <button class="prow-head" type="button" data-sku="${p.sku}" aria-label="${p.name}: open details">
        <span class="prod"><strong>${p.name}</strong><small><span class="mono">${p.sku}</span> · ${supplier}</small></span>
        ${statusBadge(statusOf(p))}
      </button>
      ${dosBar(p)}
      <div class="prow-figs">
        <span>Stock<b class="num">${int(p.stock)}</b></span>
        <span>Lead time<b class="num">${int(p.lead_time_days)} days</b></span>
        <span>Forecast ${s.period}d<b class="num">${int(forecastUnits(p, s.period))}</b></span>
      </div>
      ${r ? html`<div class="prow-actions">
        <span class="muted" style="font-size:var(--fs-sm)">Order <b class="num" style="color:var(--ink)">${int(r.qty)}</b> · <span class="num">${cents(r.line_cost)}</span></span>
        <button class="btn btn-sm ${inCart ? "is-added" : "btn-secondary"}" type="button" data-add="${p.sku}" aria-pressed="${inCart}">${inCart ? html`${icon("check", "icon-xs")}In cart` : html`${icon("plus", "icon-xs")}Add to cart`}</button>
      </div>` : ""}
    </div>
  </div></li>`;
}
