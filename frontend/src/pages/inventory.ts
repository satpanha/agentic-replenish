/** Inventory: every SKU with stock, coverage, forecast and risk, filterable and sortable. */
import { $$, html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { cents, int, money, one, pct, plural } from "../lib/format.js";
import { forecastUnits, statusOf, supplierMap } from "../data/model.js";
import { addToCart, go, store } from "../state.js";
import { statusBadge } from "../ui/status.js";
import { bindSort, emptyState, filterSelect, pageHead, pager, sortBy, sortHeads } from "../ui/kit.js";
import { toast } from "../ui/overlay.js";
import { highlight } from "../lib/motion.js";

const PAGE = 15;

/** Average units per day over the last n days of history. */
export const velocity = (p: import("../data/types.js").Product, n: number) => { const h = p.forecast.history.slice(-n); return h.reduce((a, b) => a + b, 0) / Math.max(1, h.length); };

export const grossMargin = (p: import("../data/types.js").Product) => (p.unit_price - p.unit_cost) / p.unit_price;

export function mountInventory(root: HTMLElement) {
  document.title = "Inventory · StockPulse AMD";
  const params = store.get().routeParams;
  const f = { q: params.q || "", category: params.category || "all", supplier: params.supplier || "all", status: params.status || "all" };
  let sort = (({ key: "status", dir: 1 }) as {key: string, dir: 1 | -1});
  let page = 0;
  const sel: Set<string> = new Set();
  /** status per SKU as last shown, to mark rows whose status changed after a recalculation */
  let shownStatus: Map<string, string> | null = null;
  let shownData = (null as object | null);

  function render() {
    const s = store.get();
    if (!s.data) { setHTML(root, html`<div class="panel">${emptyState({ title: "Loading inventory…", iconName: "refresh" })}</div>`); return; }
    const d = s.data;
    const sup = supplierMap(d);
    const q = f.q.trim().toLowerCase();
    const R = d.policy.review_days;
    let rows = d.products.filter((p) => (f.category === "all" || p.category === f.category) && (f.supplier === "all" || p.supplier_id === f.supplier)
      && (f.status === "all" || statusOf(p).level === f.status) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q)));
    const vals: Record<string, (p: import("../data/types.js").Product) => number | string> = {
      name: (p) => p.name, category: (p) => p.category, supplier: (p) => sup[p.supplier_id].name, stock: (p) => p.stock,
      velocity: (p) => velocity(p, 7), forecast: (p) => forecastUnits(p, s.period), dos: (p) => p.days_cover_incl_pipeline,
      lead: (p) => p.lead_time_days, cost: (p) => p.unit_cost, margin: grossMargin,
      status: (p) => statusOf(p).rank * 1e4 + p.days_cover_incl_pipeline / Math.max(1, p.lead_time_days),
    };
    rows = sortBy(rows, vals[sort.key] || vals.status, sort.dir);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    page = Math.min(page, pages - 1);
    const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
    const totalValue = rows.reduce((a, p) => a + p.stock * p.unit_cost, 0);
    const keep = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const allOnPage = shown.length > 0 && shown.every((p) => sel.has(p.sku));
    const someOnPage = shown.some((p) => sel.has(p.sku));

    setHTML(root, html`
      ${pageHead({ title: "Inventory", sub: html`${plural(d.products.length, "SKU")} from ${plural(d.suppliers.length, "supplier")} · ${money(d.products.reduce((a, p) => a + p.stock * p.unit_cost, 0))} at cost · ${d.is_sample_data ? "sample dataset" : "imported data"}`,
        actions: html`<button class="btn btn-secondary" type="button" data-action="import">${icon("upload", "icon-sm")}Import data</button>` })}
      <section class="panel">
        <div class="toolbar" style="padding-top:16px" role="group" aria-label="Filters">
          <div class="search-field">${icon("search", "icon-sm")}<input class="input" type="search" placeholder="Product name or SKU" aria-label="Search inventory" value="${f.q}" data-inv-q data-key="inv-q"></div>
          ${filterSelect("category", "Category", [{ value: "all", label: "All categories" }, ...[...new Set(d.products.map((p) => p.category))].sort().map((c) => ({ value: c, label: c }))], f.category)}
          ${filterSelect("supplier", "Supplier", [{ value: "all", label: "All suppliers" }, ...d.suppliers.map((x) => ({ value: x.supplier_id, label: x.name }))], f.supplier)}
          ${filterSelect("status", "Stock status", [{ value: "all", label: "Any status" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "excess", label: "Excess" }, { value: "healthy", label: "Healthy" }], f.status)}
          <span class="spacer"></span>
          ${f.q || f.category !== "all" || f.supplier !== "all" || f.status !== "all" ? html`<button class="btn btn-ghost btn-sm" type="button" data-clear>Clear filters</button>` : ""}
        </div>
        ${sel.size ? html`<div class="selection-bar"><strong>${plural(sel.size, "SKU")} selected</strong>
          <span>${d.products.filter((p) => sel.has(p.sku) && !s.cart[p.sku]).length} not yet in the cart</span><span style="flex:1"></span>
          <button class="btn btn-sm btn-primary" type="button" data-bulk-add>${icon("plus", "icon-xs")}Add to cart</button>
          <button class="btn btn-sm btn-ghost" type="button" data-bulk-clear>Clear selection</button></div>` : ""}
        ${rows.length ? html`<div class="table-wrap"><table class="ptable inv-table">
          <thead><tr>
            <th scope="col"><input type="checkbox" class="checkbox" data-page-all aria-label="Select all on this page" ${allOnPage ? "checked" : ""} data-indeterminate="${!allOnPage && someOnPage}"></th>
            ${sortHeads([{ key: "name", label: "Product" }, { key: "category", label: "Category", cls: "secondary" }, { key: "stock", label: "On hand", num: true },
              { key: "velocity", label: "Sales/day", num: true }, { key: "forecast", label: `Forecast ${s.period}d`, num: true }, { key: "dos", label: "Days of supply", num: true },
              { key: "lead", label: "Lead", num: true }, { key: "cost", label: "Unit cost", num: true, cls: "secondary" }, { key: "margin", label: "Margin", num: true, cls: "secondary" },
              { key: "status", label: "Status" }], sort)}
          </tr></thead>
          <tbody>${shown.map((p) => {
            const st = statusOf(p), v7 = velocity(p, 7), v28 = velocity(p, 28);
            const cover = p.days_cover_incl_pipeline;
            return html`<tr data-sku="${p.sku}" tabindex="0" class="${sel.has(p.sku) ? "is-selected" : ""}" aria-label="${p.name}, ${st.label}. Open details">
              <td><input type="checkbox" class="checkbox" data-pick="${p.sku}" aria-label="Select ${p.name}" ${sel.has(p.sku) ? "checked" : ""}></td>
              <td><div class="prod"><strong>${p.name}</strong><small><span class="mono">${p.sku}</span> · ${sup[p.supplier_id].name}</small></div></td>
              <td class="secondary">${p.category}</td>
              <td class="r num"><b>${int(p.stock)}</b>${p.on_order ? html`<span class="cell-sub">+${int(p.on_order)} on order</span>` : ""}</td>
              <td class="r num">${one(v7)}<span class="cell-sub ${v7 > v28 * 1.15 ? "up" : v7 < v28 * 0.85 ? "down" : ""}">28d ${one(v28)}</span></td>
              <td class="r num">${int(forecastUnits(p, s.period))}</td>
              <td class="r num"><b class="${cover < p.lead_time_days ? "txt-critical" : cover < p.lead_time_days + R ? "txt-warning" : ""}">${cover >= 100 ? int(cover) : one(cover)}</b></td>
              <td class="r num">${int(p.lead_time_days)}d</td>
              <td class="r num secondary">${cents(p.unit_cost)}</td>
              <td class="r num secondary">${pct(grossMargin(p), 0)}</td>
              <td>${statusBadge(st)}</td>
            </tr>`;
          })}</tbody></table></div>
          ${pager(rows.length, page, PAGE)}
          <p class="table-note">${plural(rows.length, "SKU")} · ${money(totalValue)} at cost. Days of supply = (on hand + on order) ÷ forecast daily demand. No reserved quantities are tracked in this dataset.</p>`
        : emptyState({ title: "No SKUs match these filters", body: "Clear a filter or search for a different name.", action: html`<button class="btn btn-secondary btn-sm" type="button" data-clear>Clear filters</button>` })}
      </section>`);
    $$("[data-indeterminate='true']", root).forEach((el) => { (el as HTMLInputElement).indeterminate = true; });
    if (keep) (root.querySelector(`[data-key="${keep}"]`) as HTMLElement | null)?.focus();
    if (shownStatus && shownData !== d) {
      const before = shownStatus;
      const moved = shown.filter((p) => before.get(p.sku) && before.get(p.sku) !== statusOf(p).label);
      highlight(moved.map((p) => (root.querySelector(`tr[data-sku="${p.sku}"]`) as Element)).filter(Boolean), "amber");
    }
    shownStatus = new Map(d.products.map((p) => [p.sku, statusOf(p).label]));
    shownData = d;
  }

  on(root, "input", "[data-inv-q]", (_e, t) => { f.q = (t as HTMLInputElement).value; page = 0; render(); });
  on(root, "change", "[data-filter-select]", (_e, t) => { (f as Record<string, string>)[t.dataset.filterSelect as string] = (t as HTMLSelectElement).value; page = 0; render(); });
  on(root, "click", "[data-clear]", () => { Object.assign(f, { q: "", category: "all", supplier: "all", status: "all" }); page = 0; render(); });
  on(root, "click", "[data-page]", (_e, t) => { page = Number(t.dataset.page); render(); root.scrollIntoView({ block: "start" }); });
  on(root, "change", "[data-pick]", (_e, t) => { const k = (t.dataset.pick as string); sel.has(k) ? sel.delete(k) : sel.add(k); render(); });
  on(root, "change", "[data-page-all]", (_e, t) => {
    const on_ = (t as HTMLInputElement).checked;
    $$("[data-pick]", root).forEach((x) => (on_ ? sel.add((x.dataset.pick as string)) : sel.delete((x.dataset.pick as string))));
    render();
  });
  on(root, "click", "[data-bulk-add]", () => {
    const added = addToCart([...sel]);
    sel.clear();
    render();
    toast(`${plural(added.length, "line")} added to the cart`, { label: "Review cart", run: () => go("cart") });
  });
  on(root, "click", "[data-bulk-clear]", () => { sel.clear(); render(); });
  on(root, "click", "tbody tr[data-sku]", (e, t) => {
    if ((e.target as Element).closest("input, button, a")) return;
    store.set({ drawer: { type: "sku", sku: (t.dataset.sku as string) } });
  });
  on(root, "keydown", "tbody tr[data-sku]", (e, t) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" && e.target === t) store.set({ drawer: { type: "sku", sku: (t.dataset.sku as string) } });
    if (k === "ArrowDown" || k === "ArrowUp") { ((k === "ArrowDown" ? t.nextElementSibling : t.previousElementSibling) as HTMLElement | null)?.focus(); e.preventDefault(); }
  });
  bindSort(root, () => sort, (s) => { sort = s; page = 0; render(); });

  render();
  const unsub = store.subscribe((_s, ch) => { if (ch.has("data") || ch.has("cart") || ch.has("period")) render(); });
  return () => unsub();
}
