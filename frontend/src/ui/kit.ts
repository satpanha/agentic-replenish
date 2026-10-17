/** Page-level building blocks shared by every Phase 2 screen. */
import { html, on } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { int } from "../lib/format.js";

export const pageHead = (o: {title: string, sub?: unknown, actions?: unknown, id?: string}) => html`
  <header class="page-head">
    <div><h1 id="${o.id || "page-title"}">${o.title}</h1>${o.sub ? html`<p class="page-sub">${o.sub}</p>` : ""}</div>
    ${o.actions ? html`<div class="page-actions">${o.actions}</div>` : ""}
  </header>`;

/** Sortable header cells. */
export const sortHeads = (cols: {key: string, label: string, num?: boolean, cls?: string}[], sort: {key: string, dir: 1 | -1}) => html`${cols.map((c) => html`
  <th scope="col" class="${c.num ? "r" : ""} ${c.cls || ""}" ${sort.key === c.key ? html`aria-sort="${sort.dir === 1 ? "ascending" : "descending"}"` : ""}>
    ${c.key ? html`<button class="sort-btn" type="button" data-sort="${c.key}">${c.label}${icon("arrowUp")}</button>` : html`<span>${c.label}</span>`}
  </th>`)}`;

/**
 * Toggle sort on click.
 * @param ascFirst keys that start ascending
 */
export function bindSort(root: HTMLElement, get: () => {key: string, dir: 1 | -1}, set: (s: {key: string, dir: 1 | -1}) => void, ascFirst: string[] = ["name", "sku", "supplier", "category"]) {
  return on(root, "click", "[data-sort]", (_e, t) => {
    const key = (t.dataset.sort as string);
    const cur = get();
    const first = ((ascFirst.includes(key) ? 1 : -1) as 1 | -1);
    set(cur.key === key ? { key, dir: (-cur.dir as 1 | -1) } : { key, dir: first });
  });
}

export function sortBy<T>(rows: T[], val: (r: T) => number | string | null | undefined, dir: 1 | -1) {
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number)) * dir;
  });
}

/** @param page 0-based */
export function pager(total: number, page: number, size: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? page * size + 1 : 0, to = Math.min(total, (page + 1) * size);
  return html`<div class="table-foot">
    <span>${total ? `${int(from)}–${int(to)} of ${int(total)}` : "No results"}</span>
    ${pages > 1 ? html`<span class="pager">
      <button class="btn btn-sm btn-ghost" type="button" data-page="${page - 1}" ${page <= 0 ? "disabled" : ""} aria-label="Previous page">${icon("chevronRight", "icon-xs flip")}Previous</button>
      <span class="num">Page ${page + 1} of ${pages}</span>
      <button class="btn btn-sm btn-ghost" type="button" data-page="${page + 1}" ${page >= pages - 1 ? "disabled" : ""} aria-label="Next page">Next${icon("chevronRight", "icon-xs")}</button>
    </span>` : ""}
  </div>`;
}

export const emptyState = (o: {title: string, body?: unknown, action?: unknown, iconName?: import("../lib/icons.js").IconName}) => html`<div class="state">${icon(o.iconName || "search")}<strong>${o.title}</strong>${o.body ? html`<span>${o.body}</span>` : ""}${o.action || ""}</div>`;

/** Severity chip shared by Risk Radar and the assistant. */
export const severityChip = (s: "critical" | "high" | "medium" | "low") => html`<span class="status sev-${s}">${icon(s === "critical" ? "octagon" : s === "high" ? "alert" : s === "medium" ? "info" : "clock")}${s[0].toUpperCase() + s.slice(1)}</span>`;

/** Filter <select>. */
export const filterSelect = (name: string, label: string, opts: {value: string, label: string}[], value: string) => html`
  <label class="visually-hidden" for="f-${name}">${label}</label>
  <select class="select" id="f-${name}" data-filter-select="${name}">
    ${opts.map((o) => html`<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`)}
  </select>`;

/** Mini sparkline (no axes) for drawers. */
export function sparkline(values: number[], w: number = 360, h: number = 56) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`).join(" ");
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"></polyline></svg>`;
}
