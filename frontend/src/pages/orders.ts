/** Purchase Orders: list, detail with status-driven actions, and a printable document preview. */
import { $, html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { addDays, cents, dayDate, int, plural, shortDate } from "../lib/format.js";
import { approver, dispatchPO, getPO, listPOs, transitionPO } from "../data/api.js";
import { dispatchState, poChecks } from "../data/po.js";
import { go, load, store } from "../state.js";
import { WORKSPACE } from "../data/demo.js";
import { emptyState, filterSelect, pageHead, sortBy, sortHeads, bindSort } from "../ui/kit.js";
import { toast } from "../ui/overlay.js";
import { confirmState, enterBlock, highlight } from "../lib/motion.js";

export type PO = import("../data/types.js").PurchaseOrder;

export const PO_STATUS = (({
  draft: { label: "Draft", level: "excess", icon: "file" },
  pending: { label: "Pending approval", level: "warning", icon: "clock" },
  approved: { label: "Approved · ready to dispatch", level: "info", icon: "checkCircle" },
  sent: { label: "Sent", level: "info", icon: "arrowRight" },
  acknowledged: { label: "Acknowledged", level: "healthy", icon: "checkCircle" },
  rejected: { label: "Rejected", level: "critical", icon: "x" },
  cancelled: { label: "Cancelled", level: "excess", icon: "x" },
  superseded: { label: "Superseded", level: "excess", icon: "refresh" },
}) as Record<string, {label: string, level: string, icon: import("../lib/icons.js").IconName}>);
const ACTION_LABEL = { submit: "Submit for approval", approve: "Approve", return: "Return for revision", reject: "Reject", mark_sent: "Record that I sent it", acknowledge: "Record supplier acknowledgement", cancel: "Cancel order", simulated_dispatch: "Simulated dispatch" };
type Action = Exclude<keyof typeof ACTION_LABEL, "simulated_dispatch">;
const NEXT: Record<string, Action[]> = {
  draft: ["submit", "cancel"], pending: ["approve", "return", "reject", "cancel"], approved: ["mark_sent", "cancel"], sent: ["acknowledge"],
};
const GATED = new Set(["approve", "return", "reject", "mark_sent", "acknowledge", "cancel"]);
const CONFIRM_TEXT: Record<string, string> = {
  approve: "Approving makes this order ready to dispatch.",
  return: "The order goes back to draft with your note, so it can be revised and resubmitted.",
  reject: "Rejected orders can't be reopened.",
  mark_sent: "This records that you sent the order yourself. StockPulse does not transmit it.",
  acknowledge: "Record this only after the supplier has confirmed the order.",
  cancel: "Cancelled orders can't be reopened.",
};
const CHANNELS = [
  { id: "email", label: "Supplier email", note: "SMTP / mailbox integration" },
  { id: "webhook", label: "Supplier webhook / EDI", note: "Supplier's order endpoint" },
  { id: "evolus", label: "Evolus AI workflow", note: "Partner workflow automation" },
] as const;

export const poNumber = (po: PO) => `PO-${String(po.id).padStart(5, "0")}`;

export const poBadge = (st: string) => { const s = PO_STATUS[st] || PO_STATUS.draft; return html`<span class="status status-${s.level}">${icon(s.icon)}${s.label}</span>`; };

const when = (iso: string) => { const d = new Date(iso); return `${shortDate(d)}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`; };

export function mountOrders(root: HTMLElement) {
  const sub = store.get().routeSub;
  const [idStr, view] = sub.split("/");
  if (idStr && /^\d+$/.test(idStr)) return view === "preview" ? mountPreview(root, Number(idStr)) : mountDetail(root, Number(idStr));
  return mountList(root);
}

// ---- list ---------------------------------------------------------------------------------------

function mountList(root: HTMLElement) {
  document.title = "Purchase Orders · StockPulse AMD";
  let pos: PO[] | null = null;
  let err = "";
  const f = { q: "", status: "active", supplier: "all" };
  /** POs just generated from the cart (?created=1,2): shown on their own until dismissed */
  let created = (store.get().routeParams.created || "").split(",").map(Number).filter(Boolean);
  let sort = (({ key: "id", dir: -1 }) as {key: string, dir: 1 | -1});

  const fetchAll = async () => {
    const first = !pos;
    try { pos = (await listPOs()).purchase_orders; err = ""; } catch (e) { err = e instanceof Error ? e.message : String(e); }
    render();
    if (first) enterBlock(root.querySelectorAll(".kpi-chip, section.panel"), { stagger: 35, max: 5 });
  };

  function render() {
    const all = pos || [];
    const suppliers = [...new Map(all.map((p) => [p.supplier_id, p.supplier_name])).entries()];
    const activeSet = new Set(["draft", "pending", "approved", "sent"]);
    const q = f.q.trim().toLowerCase();
    let rows = created.length ? all.filter((p) => created.includes(p.id)) : all.filter((p) => (f.status === "all" || (f.status === "active" ? activeSet.has(p.status) : p.status === f.status))
      && (f.supplier === "all" || p.supplier_id === f.supplier)
      && (!q || `${poNumber(p)} ${p.supplier_name} ${p.lines.map((l) => `${l.name} ${l.sku}`).join(" ")}`.toLowerCase().includes(q)));
    const vals: Record<string, (p: PO) => number | string> = { id: (p) => p.id, supplier: (p) => p.supplier_name, created: (p) => p.created_at, lines: (p) => p.lines.length, total: (p) => p.total_cost, status: (p) => p.status, updated: (p) => p.updated_at };
    rows = sortBy(rows, vals[sort.key] || vals.id, sort.dir);
    const counts = Object.fromEntries(Object.keys(PO_STATUS).map((k) => [k, all.filter((p) => p.status === k).length]));
    const keep = (document.activeElement as HTMLElement | null)?.dataset?.key;

    setHTML(root, html`
      ${pageHead({ title: "Purchase Orders", sub: "Drafts from the cart and the agent, their approval, and what happened after. Nothing is sent to a supplier automatically.",
        actions: html`<a class="btn btn-primary" href="#/cart">${icon("cart", "icon-sm")}Open Purchasing Cart</a>` })}
      <div class="kpi-strip" role="list">
        ${["draft", "pending", "approved", "sent"].map((k) => html`<button class="kpi-chip ${f.status === k ? "is-on" : ""}" type="button" role="listitem" data-status-chip="${k}">
          <b class="num">${counts[k] || 0}</b><span>${PO_STATUS[k].label}</span></button>`)}
      </div>
      ${created.length ? html`<div class="callout callout-calc created-note" role="status">${icon("checkCircle", "icon-xs")} <b>${plural(created.length, "draft")} created from the Purchasing Cart</b>, one per supplier. Open each to review, then submit it for approval. <button class="btn btn-link btn-sm" type="button" data-show-all>Show all orders</button></div>` : ""}
      <section class="panel">
        <div class="toolbar" style="padding-top:16px">
          <div class="search-field">${icon("search", "icon-sm")}<input class="input" type="search" placeholder="PO number, supplier or product" aria-label="Search purchase orders" value="${f.q}" data-po-q data-key="po-q"></div>
          ${filterSelect("status", "Status", [{ value: "active", label: "Open orders" }, { value: "all", label: "All statuses" }, ...Object.entries(PO_STATUS).map(([k, v]) => ({ value: k, label: v.label }))], f.status)}
          ${filterSelect("supplier", "Supplier", [{ value: "all", label: "All suppliers" }, ...suppliers.map(([id, name]) => ({ value: id, label: name }))], f.supplier)}
        </div>
        ${err ? emptyState({ title: "Couldn't load purchase orders", body: err, iconName: "alert", action: html`<button class="btn btn-secondary" type="button" data-retry>Try again</button>` })
          : !pos ? html`<div class="panel-body"><div class="skeleton sk-block" style="height:160px"></div></div>`
          : !rows.length ? emptyState({ title: all.length ? "No orders match" : "No purchase orders yet", body: all.length ? "Change the filters to see more." : "Generate a draft from the Purchasing Cart, or run the agent's inventory review.", iconName: "file", action: all.length ? "" : html`<a class="btn btn-primary" href="#/cart">Open Purchasing Cart</a>` })
          : html`<div class="table-wrap"><table class="ptable" style="min-width:880px">
            <thead><tr>${sortHeads([{ key: "id", label: "PO" }, { key: "supplier", label: "Supplier" }, { key: "created", label: "Created" }, { key: "lines", label: "Lines", num: true }, { key: "total", label: "Total", num: true }, { key: "status", label: "Approval" }, { key: "", label: "Dispatch" }, { key: "updated", label: "Last update" }], sort)}</tr></thead>
            <tbody>${rows.map((p) => html`<tr data-po="${p.id}" tabindex="0" aria-label="${poNumber(p)}, ${p.supplier_name}, ${PO_STATUS[p.status]?.label}">
              <td><b class="mono">${poNumber(p)}</b><span class="cell-sub">${p.created_by === "agent" ? "Drafted by agent" : "From cart"}</span></td>
              <td>${p.supplier_name}</td>
              <td class="num">${when(p.created_at)}</td>
              <td class="r num">${p.lines.length}</td>
              <td class="r num"><b>${cents(p.total_cost)}</b></td>
              <td>${poBadge(p.status)}</td>
              <td class="muted">${dispatchState(p)}</td>
              <td class="num muted">${when(p.updated_at)}</td>
            </tr>`)}</tbody></table></div>
            <div class="table-foot"><span>${plural(rows.length, "order")} · ${cents(rows.reduce((a, p) => a + p.total_cost, 0))}</span></div>`}
      </section>`);
    if (keep) (root.querySelector(`[data-key="${keep}"]`) as HTMLElement | null)?.focus();
  }

  on(root, "input", "[data-po-q]", (_e, t) => { f.q = (t as HTMLInputElement).value; render(); });
  on(root, "change", "[data-filter-select]", (_e, t) => { (f as Record<string, string>)[t.dataset.filterSelect as string] = (t as HTMLSelectElement).value; render(); });
  on(root, "click", "[data-status-chip]", (_e, t) => { f.status = f.status === t.dataset.statusChip ? "active" : (t.dataset.statusChip as string); render(); });
  on(root, "click", "[data-retry]", () => fetchAll());
  on(root, "click", "[data-show-all]", () => { created = []; history.replaceState(null, "", "#/orders"); render(); });
  on(root, "click", "tr[data-po]", (_e, t) => go(`orders/${t.dataset.po}`));
  on(root, "keydown", "tr[data-po]", (e, t) => { if ((e as KeyboardEvent).key === "Enter") go(`orders/${t.dataset.po}`); });
  bindSort(root, () => sort, (s) => { sort = s; render(); }, ["supplier", "status"]);
  render();
  fetchAll();
  return () => {};
}

// ---- detail -------------------------------------------------------------------------------------

function mountDetail(root: HTMLElement, id: number) {
  let po: PO | null = null;
  let err = "", busy = "";
  let confirming: string | null = null;
  let noteError = "";
  const fetchOne = async () => {
    try { po = await getPO(id); err = ""; } catch (e) { err = e instanceof Error ? e.message : String(e); }
    render();
    enterBlock(root.querySelectorAll(".detail-grid > .panel, .detail-side > .panel"), { stagger: 50, max: 4 });
  };

  function render() {
    document.title = `${po ? poNumber(po) : "Purchase order"} · StockPulse AMD`;
    if (err) { setHTML(root, html`${back()}<div class="panel">${emptyState({ title: "Purchase order not found", body: err, iconName: "file" })}</div>`); return; }
    if (!po) { setHTML(root, html`${back()}<div class="panel"><div class="panel-body" style="padding-top:20px"><div class="skeleton sk-block"></div></div></div>`); return; }
    const d = store.get().data;
    const s = d?.suppliers.find((x) => x.supplier_id === po?.supplier_id);
    const approvedAt = po.events.find((e) => e.action === "approve")?.at;
    const sentAt = po.events.find((e) => e.action === "mark_sent")?.at;
    const eta = sentAt ? addDays(new Date(sentAt), po.lead_time_days) : null;
    const actions = NEXT[po.status] || [];
    const { checks, blocking } = poChecks(po, d);
    const showChecks = ["draft", "pending"].includes(po.status);
    setHTML(root, html`
      ${back()}
      ${pageHead({ title: `${poNumber(po)} · ${po.supplier_name}`, sub: html`${poBadge(po.status)} <span class="muted">Created ${when(po.created_at)} by ${po.created_by === "agent" ? "the agent" : po.created_by}</span>`,
        actions: html`<a class="btn btn-secondary" href="#/orders/${po.id}/preview">${icon("file", "icon-sm")}Preview document</a>` })}
      <div class="detail-grid">
        <section class="panel" aria-labelledby="lines-h">
          <div class="panel-head"><h2 class="panel-title" id="lines-h">Line items</h2><span class="muted num">${plural(po.lines.length, "line")}</span></div>
          <div class="table-wrap"><table class="ptable" style="min-width:560px">
            <thead><tr><th scope="col">Product</th><th scope="col" class="r">Quantity</th><th scope="col" class="r">Unit price</th><th scope="col" class="r">Line total</th></tr></thead>
            <tbody>${po.lines.map((l) => html`<tr style="cursor:default"><td><div class="prod"><strong>${l.name}</strong><small class="mono">${l.sku}</small></div></td>
              <td class="r num">${int(l.qty)}${l.recommended_qty != null && l.recommended_qty !== l.qty ? html`<span class="cell-sub">recommended ${int(l.recommended_qty)}</span>` : ""}</td>
              <td class="r num">${cents(l.unit_cost)}</td><td class="r num">${cents(l.line_cost)}</td></tr>`)}</tbody>
            <tfoot><tr><td colspan="3" class="r"><b>Total order value</b></td><td class="r num"><b>${cents(po.total_cost)}</b></td></tr></tfoot>
          </table></div>
          ${po.warnings.length ? html`<div class="panel-body" style="padding-top:12px">${po.warnings.map((w) => html`<p class="issue issue-warning">${icon("alert", "icon-xs")}${w}</p>`)}</div>` : ""}
          ${showChecks ? html`<div class="po-checks" aria-labelledby="checks-h">
            <h3 id="checks-h">Checks before approval ${blocking ? html`<span class="status status-critical">${icon("octagon")}Blocking issue</span>` : html`<span class="status status-healthy">${icon("checkCircle")}Ready to approve</span>`}</h3>
            <ul>${checks.map((c) => html`<li class="${c.ok ? "ok" : c.level}">${icon(c.ok ? "checkCircle" : c.level === "error" ? "octagon" : "alert", "icon-sm")}<span><b>${c.label}</b><small>${c.detail}</small></span></li>`)}</ul>
          </div>` : ""}
        </section>
        <aside class="detail-side">
          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">Next step</h2></div>
            <div class="panel-body action-box">
              ${actions.length ? html`
                ${actions.some((a) => GATED.has(a)) ? html`<div class="field"><label for="ap-key">Approver key</label>
                  <input class="input" id="ap-key" type="password" autocomplete="off" value="${approver.key}" placeholder="Required for approval and dispatch" data-key="ap-key">
                  <small class="muted">Demo key: <code>demo-approver</code> (set APPROVER_KEY in .env)</small></div>` : ""}
                <div class="field"><label for="ap-note">Note${confirming === "return" ? " (required: what needs revising?)" : " (optional)"}</label><input class="input ${noteError ? "is-invalid" : ""}" id="ap-note" type="text" data-key="ap-note" aria-invalid="${!!noteError}" aria-describedby="ap-note-err" placeholder="${po.status === "approved" ? "e.g. emailed to orders@supplier" : "Reason or comment"}">
                  ${noteError ? html`<small class="issue issue-error" id="ap-note-err">${noteError}</small>` : ""}</div>
                ${confirming ? html`<div class="callout"><b>${ACTION_LABEL[(confirming as keyof typeof ACTION_LABEL)]}?</b> ${CONFIRM_TEXT[confirming] || ""}
                  <div class="row-actions" style="margin-top:8px"><button class="btn btn-primary btn-sm" type="button" data-confirm="${confirming}">${busy ? "Working…" : "Confirm"}</button><button class="btn btn-ghost btn-sm" type="button" data-unconfirm>Back</button></div></div>`
                : html`<div class="action-list">${actions.map((a, i) => html`<button class="btn ${i === 0 ? "btn-primary" : a === "cancel" || a === "reject" ? "btn-ghost" : "btn-secondary"}" type="button" data-act="${a}" ${busy || (a === "approve" && blocking) ? "disabled" : ""}>${ACTION_LABEL[a]}</button>`)}</div>
                  ${po.status === "pending" && blocking ? html`<small class="issue issue-error">Approval is blocked until the checks pass. Return it for revision instead.</small>` : ""}`}
                ${po.status === "approved" ? html`<a class="btn btn-link btn-sm" href="${mailto(po)}">${icon("external", "icon-xs")}Open an email to the supplier</a>` : ""}`
              : html`<p class="muted">${po.status === "acknowledged" ? "The supplier confirmed this order. Delivery tracking arrives with supplier integrations." : `No further actions for a ${PO_STATUS[po.status]?.label.toLowerCase()} order.`}</p>`}
            </div>
          </section>
          ${["approved", "sent", "acknowledged"].includes(po.status) ? html`<section class="panel" aria-labelledby="disp-h">
            <div class="panel-head"><div><h2 class="panel-title" id="disp-h">Dispatch</h2><p class="panel-sub">No dispatch integration is connected. Simulations record a demo only; nothing reaches the supplier.</p></div></div>
            <ul class="integrations">${CHANNELS.map((ch) => html`<li><div><b>${ch.label}</b><p class="muted">${ch.note} · not connected</p></div>
              ${po?.status === "approved" ? html`<button class="btn btn-sm btn-secondary" type="button" data-dispatch="${ch.id}" ${busy ? "disabled" : ""}>Simulate (demo)</button>` : html`<span class="status status-excess">Not connected</span>`}</li>`)}</ul>
            ${po.dispatch?.length ? html`<ol class="timeline panel-body" style="padding-top:12px">${po.dispatch.slice().reverse().map((r) => html`<li><span class="tl-dot"></span><div><b>${r.channel_label} · simulated</b><span class="muted">${when(r.at)} · ${r.by}</span><p>${r.result}</p></div></li>`)}</ol>` : ""}
          </section>` : ""}
          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">Supplier and terms</h2></div>
            <dl class="kv panel-body">
              <div><dt>Supplier</dt><dd>${po.supplier_name} <span class="mono muted">${po.supplier_id}</span></dd></div>
              <div><dt>Lead time</dt><dd>${int(po.lead_time_days)} days${s ? ` (± ${s.lead_time_std_days})` : ""}</dd></div>
              <div><dt>Minimum order</dt><dd>${s ? cents(s.min_order_value) : "Not on file"}</dd></div>
              <div><dt>Payment terms</dt><dd>${po.terms.payment_terms || html`<span class="muted">Not on file</span>`}</dd></div>
              <div><dt>Currency</dt><dd>${po.terms.currency || "USD"}</dd></div>
              <div><dt>Expected delivery</dt><dd>${eta ? `${dayDate(eta)} (sent + lead time)` : approvedAt ? "Known once sent" : html`<span class="muted">After approval and dispatch</span>`}</dd></div>
            </dl>
          </section>
          <section class="panel">
            <div class="panel-head"><h2 class="panel-title">History</h2></div>
            <ol class="timeline panel-body">${po.events.slice().reverse().map((e) => html`<li><span class="tl-dot tl-${e.status}"></span><div>
              <b>${e.action === "created" ? `Created as ${PO_STATUS[e.status]?.label.toLowerCase()}` : ACTION_LABEL[(e.action as keyof typeof ACTION_LABEL)] || e.action}</b>
              <span class="muted">${when(e.at)} · ${e.by}</span>${e.note ? html`<p>${e.note}</p>` : ""}</div></li>`)}</ol>
          </section>
        </aside>
      </div>`);
  }

  on(root, "click", "[data-act]", (_e, t) => {
    const a = (t.dataset.act as string);
    if (a === "submit") return doAct(a);
    confirming = a;
    render();
  });
  on(root, "click", "[data-unconfirm]", () => { confirming = null; noteError = ""; render(); });
  on(root, "click", "[data-dispatch]", async (_e, t) => {
    if (!po) return;
    busy = "dispatch";
    render();
    try {
      po = await dispatchPO(po.id, t.dataset.dispatch as "email" | "webhook" | "evolus");
      toast("Simulated dispatch recorded. Nothing was sent to the supplier.");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    busy = "";
    render();
    enterBlock(root.querySelectorAll("[aria-labelledby='disp-h'] .timeline li:first-child"));
  });
  on(root, "click", "[data-confirm]", (_e, t) => doAct((t.dataset.confirm as string)));
  on(root, "input", "#ap-key", (_e, t) => { approver.key = (t as HTMLInputElement).value; });

  async function doAct(a: string) {
    if (!po) return;
    const note = (($("#ap-note", root)) as HTMLInputElement | null)?.value || "";
    if (a === "return" && !note.trim()) {
      noteError = "Say what needs revising before returning the order.";
      render();
      ($("#ap-note", root) as HTMLInputElement | null)?.focus();
      return;
    }
    noteError = "";
    busy = a;
    try {
      const updated: PO = await transitionPO(po.id, a as Parameters<typeof transitionPO>[1], note);
      po = updated;
      confirming = null;
      busy = "";
      render();
      // only after the server confirmed the new state
      confirmState(root.querySelector(".page-sub .status"));
      enterBlock(root.querySelectorAll(".timeline li:first-child"));
      if (updated.status === "approved" || updated.status === "acknowledged") highlight(root.querySelectorAll(".page-sub .status")[0] || [], "green");
      toast(`${poNumber(updated)}: ${PO_STATUS[updated.status].label}`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    busy = "";
    render();
  }
  const back = () => html`<a class="back-link" href="#/orders">${icon("chevronRight", "icon-xs flip")}All purchase orders</a>`;
  render();
  fetchOne();
  return () => {};
}

function mailto(po: PO) {
  const body = [`Purchase order ${poNumber(po)} from ${WORKSPACE.name}`, "", ...po.lines.map((l) => `${l.qty} x ${l.name} (${l.sku}) @ ${l.unit_cost.toFixed(2)} = ${l.line_cost.toFixed(2)}`), "", `Total: ${po.total_cost.toFixed(2)} ${po.terms.currency || "USD"}`, "", "Please confirm receipt and expected delivery date."].join("\n");
  return `mailto:?subject=${encodeURIComponent(`${poNumber(po)} ${WORKSPACE.name}`)}&body=${encodeURIComponent(body)}`;
}

// ---- preview ------------------------------------------------------------------------------------

function mountPreview(root: HTMLElement, id: number) {
  (async () => {
    setHTML(root, html`<div class="panel"><div class="panel-body" style="padding-top:20px"><div class="skeleton sk-block"></div></div></div>`);
    try {
      const po = await getPO(id);
      document.title = `${poNumber(po)} preview · StockPulse AMD`;
      const approved = po.events.find((e) => e.action === "approve");
      const official = ["approved", "sent", "acknowledged"].includes(po.status);
      setHTML(root, html`
        <div class="preview-bar no-print">
          <a class="back-link" href="#/orders/${po.id}">${icon("chevronRight", "icon-xs flip")}Back to ${poNumber(po)}</a>
          <button class="btn btn-primary" type="button" data-print>${icon("file", "icon-sm")}Print or save as PDF</button>
        </div>
        <article class="po-doc ${official ? "" : "is-draft"}" aria-label="Purchase order document">
          ${official ? "" : html`<div class="watermark" aria-hidden="true">${PO_STATUS[po.status]?.label.split(" ")[0].toUpperCase()}</div>`}
          <header class="po-doc-head">
            <div><div class="po-brand"><b>${WORKSPACE.name}</b><span>Purchasing via StockPulse AMD</span></div>
              <address>${WORKSPACE.address.map((a) => html`${a}<br>`)}</address></div>
            <div class="po-title"><h1>Purchase order</h1><dl>
              <div><dt>Number</dt><dd class="mono">${poNumber(po)}</dd></div>
              <div><dt>Order date</dt><dd>${dayDate(new Date(approved?.at || po.created_at))}</dd></div>
              <div><dt>Status</dt><dd>${PO_STATUS[po.status]?.label}</dd></div></dl></div>
          </header>
          <section class="po-parties">
            <div><h2>Supplier</h2><p><b>${po.supplier_name}</b><br>Supplier ID ${po.supplier_id}<br><span class="muted">Address and contact not on file</span></p></div>
            <div><h2>Deliver to</h2><p><b>${WORKSPACE.name}</b><br>${WORKSPACE.address.join(", ")}</p></div>
            <div><h2>Delivery</h2><p>Lead time ${int(po.lead_time_days)} days from dispatch<br>${approved ? `Expected around ${dayDate(addDays(new Date(approved.at), po.lead_time_days))} if sent on approval` : "Date set on approval"}</p></div>
          </section>
          <table class="po-lines">
            <thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col">SKU</th><th scope="col" class="r">Qty</th><th scope="col" class="r">Unit price</th><th scope="col" class="r">Amount</th></tr></thead>
            <tbody>${po.lines.map((l, i) => html`<tr><td class="num">${i + 1}</td><td>${l.name}</td><td class="mono">${l.sku}</td><td class="r num">${int(l.qty)}</td><td class="r num">${cents(l.unit_cost)}</td><td class="r num">${cents(l.line_cost)}</td></tr>`)}</tbody>
            <tfoot>
              <tr><td colspan="5" class="r">Subtotal</td><td class="r num">${cents(po.total_cost)}</td></tr>
              <tr><td colspan="5" class="r">Tax</td><td class="r num muted">Not calculated</td></tr>
              <tr class="grand"><td colspan="5" class="r">Total (${po.terms.currency || "USD"})</td><td class="r num">${cents(po.total_cost)}</td></tr>
            </tfoot>
          </table>
          <footer class="po-doc-foot">
            <div><h2>Terms</h2><p>Payment terms: ${po.terms.payment_terms || "to be agreed with supplier"}. Quantities are whole cases and respect the supplier's minimum order quantities.</p></div>
            <div><h2>Notes</h2><p>${po.rationale || "None"}${po.events.filter((e) => e.action === "return").map((e) => html`<br>Returned for revision ${dayDate(new Date(e.at))}: ${e.note}`)}${po.dispatch?.length ? html`<br>Dispatch so far is simulated only (demo); this order has not been transmitted electronically.` : ""}</p></div>
            <div><h2>Authorisation</h2><p>${approved ? html`Approved by <b>${approved.by}</b> on ${dayDate(new Date(approved.at))}` : html`<span class="muted">Not yet approved. This document is not valid for ordering.</span>`}</p></div>
          </footer>
        </article>`);
      root.querySelector("[data-print]")?.addEventListener("click", () => window.print());
      enterBlock(root.querySelectorAll(".po-doc"));
    } catch (e) {
      setHTML(root, html`<div class="panel">${emptyState({ title: "Purchase order not found", body: e instanceof Error ? e.message : String(e), iconName: "file" })}</div>`);
    }
  })();
  return () => {};
}
