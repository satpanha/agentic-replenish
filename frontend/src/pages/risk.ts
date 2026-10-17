/** Risk Radar: deterministic risk rules turned into a prioritised, filterable decision list. */
import { html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { int, money, plural } from "../lib/format.js";
import { getOptimization } from "../data/optimizer.js";
import { RISK_TYPES, SEVERITIES, riskItems } from "../data/risk.js";
import { store } from "../state.js";
import { prov } from "../ui/status.js";
import { emptyState, filterSelect, pageHead, severityChip } from "../ui/kit.js";

/** Last computed list, so the drawer can open an item by id. */
export let lastRisks: import("../data/risk.js").RiskItem[] = [];

export function mountRisk(root: HTMLElement) {
  document.title = "Risk Radar · StockPulse AMD";
  const params = store.get().routeParams;
  const f = { severity: "all", type: params.type || "all", supplier: params.supplier || "all", category: "all", q: params.sku || "" };
  let opt: import("../data/types.js").Optimization | null = null;
  let optErr = "";

  async function refresh() {
    const s = store.get();
    if (!s.data) return;
    try { opt = await getOptimization(s.settings.budget); optErr = ""; } catch (e) { optErr = e instanceof Error ? e.message : String(e); }
    render();
  }

  function render() {
    const s = store.get();
    if (!s.data) { setHTML(root, html`<div class="panel">${emptyState({ title: "Loading risks…", iconName: "refresh" })}</div>`); return; }
    const d = s.data;
    const all = riskItems(d, opt, s.docs);
    lastRisks = all;
    const q = f.q.trim().toLowerCase();
    const items = all.filter((r) => (f.severity === "all" || r.severity === f.severity) && (f.type === "all" || r.type === f.type)
      && (f.supplier === "all" || r.subject.supplier_id === f.supplier)
      && (f.category === "all" || r.subject.category === f.category)
      && (!q || `${r.subject.name} ${r.subject.id}`.toLowerCase().includes(q)));
    const bySev = Object.fromEntries(SEVERITIES.map((sv) => [sv, all.filter((r) => r.severity === sv).length]));
    const keep = (document.activeElement as HTMLElement | null)?.dataset?.key;

    setHTML(root, html`
      ${pageHead({ title: "Risk Radar", sub: "Forecasts, stock, supplier documents and the budget, checked against fixed rules. Every severity below comes from a stated threshold, never from a model's judgement." })}
      <div class="sev-strip" role="group" aria-label="Filter by severity">
        ${SEVERITIES.map((sv) => html`<button type="button" class="sev-card sev-card-${sv} ${f.severity === sv ? "is-on" : ""}" aria-pressed="${f.severity === sv}" data-sev="${sv}">
          <b class="num">${bySev[sv]}</b><span>${sv[0].toUpperCase() + sv.slice(1)}</span></button>`)}
        <div class="sev-types">${RISK_TYPES.map((t) => html`<button type="button" class="type-chip ${f.type === t.id ? "is-on" : ""}" aria-pressed="${f.type === t.id}" data-type="${t.id}">${t.label}<span class="n num">${all.filter((r) => r.type === t.id).length}</span></button>`)}</div>
      </div>
      <section class="panel">
        <div class="toolbar" style="padding-top:16px">
          <div class="search-field">${icon("search", "icon-sm")}<input class="input" type="search" placeholder="Product, SKU or supplier" aria-label="Search risks" value="${f.q}" data-rq data-key="rq"></div>
          ${filterSelect("severity", "Severity", [{ value: "all", label: "All severities" }, ...SEVERITIES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))], f.severity)}
          ${filterSelect("type", "Risk type", [{ value: "all", label: "All risk types" }, ...RISK_TYPES.map((t) => ({ value: t.id, label: t.label }))], f.type)}
          ${filterSelect("supplier", "Supplier", [{ value: "all", label: "All suppliers" }, ...d.suppliers.map((x) => ({ value: x.supplier_id, label: x.name }))], f.supplier)}
          ${filterSelect("category", "Category", [{ value: "all", label: "All categories" }, ...[...new Set(d.products.map((p) => p.category))].sort().map((c) => ({ value: c, label: c }))], f.category)}
        </div>
        ${optErr ? html`<p class="callout callout-critical" style="margin:0 20px 12px">Budget risks unavailable: ${optErr}</p>` : !opt ? html`<p class="muted" style="margin:0 20px 12px;font-size:var(--fs-xs)">Checking budget risks…</p>` : ""}
        ${items.length ? html`<ul class="risk-list">${items.map((r) => html`<li>
          <button class="risk-row" type="button" data-risk="${r.id}" aria-label="${r.severity} ${r.type} risk: ${r.subject.name}. ${r.title}. Open details">
            <span class="risk-sev">${severityChip(r.severity)}</span>
            <span class="risk-main">
              <span class="risk-subject">${r.subject.name} <span class="muted">${r.subject.kind === "sku" ? r.subject.id : "Supplier"}</span></span>
              <span class="risk-title">${r.title}</span>
              <span class="risk-evidence">${r.evidence[0]}</span>
            </span>
            <span class="risk-type">${RISK_TYPES.find((t) => t.id === r.type)?.label}${r.source === "ai" ? html`<span class="prov prov-ai">From a document</span>` : ""}</span>
            <span class="risk-measure num">${r.measure}${r.leadTime != null ? html`<span class="cell-sub">lead ${int(r.leadTime)}d</span>` : ""}</span>
            <span class="risk-impact">${r.impact}</span>
          </button>
          <span class="risk-next"><button class="btn btn-sm btn-secondary" type="button" data-action="${r.next.action}" data-arg="${r.next.arg}">${r.next.label}</button></span>
        </li>`)}</ul>
        <div class="table-foot"><span>${plural(items.length, "risk")} shown${items.length !== all.length ? ` of ${all.length}` : ""}</span>
          <span>${money(items.filter((r) => r.type === "stockout" && r.severity === "critical").reduce((a, r) => a + r.impactValue, 0))} margin at risk in critical stockouts</span></div>`
        : emptyState({ title: all.length ? "No risks match these filters" : "No risks found", body: all.length ? "Clear a filter to see more." : "Every product is covered through its lead time, nothing is overstocked and the budget covers all recommended orders.", iconName: "checkCircle" })}
      </section>
      <details class="assumptions"><summary>${prov("calc")} How severities are assigned</summary><ul>
        ${[...new Map(all.map((r) => [r.type, r.rule])).entries()].map(([t, rule]) => html`<li><b>${RISK_TYPES.find((x) => x.id === t)?.label}:</b> ${rule}</li>`)}
        <li>Forecasts with too little history are capped at low severity. Supplier-document risks stay “if confirmed” until reviewed in the Supplier Inbox.</li>
      </ul></details>`);
    if (keep) (root.querySelector(`[data-key="${keep}"]`) as HTMLElement | null)?.focus();
  }

  on(root, "click", "[data-sev]", (_e, t) => { f.severity = f.severity === t.dataset.sev ? "all" : (t.dataset.sev as string); render(); });
  on(root, "click", "[data-type]", (_e, t) => { f.type = f.type === t.dataset.type ? "all" : (t.dataset.type as string); render(); });
  on(root, "change", "[data-filter-select]", (_e, t) => { (f as Record<string, string>)[t.dataset.filterSelect as string] = (t as HTMLSelectElement).value; render(); });
  on(root, "input", "[data-rq]", (_e, t) => { f.q = (t as HTMLInputElement).value; render(); });
  on(root, "click", "[data-risk]", (_e, t) => store.set({ drawer: { type: "risk", id: (t.dataset.risk as string) } }));

  render();
  refresh();
  const unsub = store.subscribe((_s, ch) => {
    if (ch.has("data") || ch.has("settings")) { opt = null; refresh(); render(); }
    else if (ch.has("docs")) render();
  });
  return () => unsub();
}
