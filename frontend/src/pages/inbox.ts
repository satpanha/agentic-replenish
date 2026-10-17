/** Supplier Inbox: intake, document list and extraction review. Nothing changes trusted data until confirmed. */
import { $, html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { cents, int, pct, plural, shortDate } from "../lib/format.js";
import { DOC_TYPE_LABEL, INBOX_FIXTURES } from "../data/demo.js";
import { CONF_THRESHOLD, fieldCount, lineChanges, lineIssues, parseEmail } from "../data/inbox.js";
import { confirmUpdates, listUpdates, revertUpdate } from "../data/api.js";
import { go, load, store, updateDoc } from "../state.js";
import { prov } from "../ui/status.js";
import { emptyState, filterSelect, pageHead } from "../ui/kit.js";
import { toast } from "../ui/overlay.js";
import { openImport } from "../ui/import-dialog.js";
import { confirmState, enterBlock, highlight } from "../lib/motion.js";
import { animate } from "animejs";

/** Simulated extraction time for sample documents. The progress bar runs on the same clock. */
const SIM_MS = 1400;
const STEPS = [["uploaded", "Uploaded"], ["processing", "Processing"], ["needs_review", "Needs review"], ["verified", "Verified"]];

const stepper = (doc: Doc) => {
  const at = doc.state === "failed" ? 1 : doc.state === "rejected" ? 2 : STEPS.findIndex(([k]) => k === doc.state);
  return html`<ol class="steps" aria-label="Document progress">${STEPS.map(([k, label], i) => {
    const st = doc.state === "failed" && i === 1 ? "failed" : doc.state === "rejected" && i === 2 ? "failed" : i < at ? "done" : i === at ? "current" : "todo";
    return html`<li class="step step-${st}" data-step="${k}" ${i === at ? html`aria-current="step"` : ""}><span class="step-dot">${st === "done" ? icon("check", "icon-xs") : st === "failed" ? icon("x", "icon-xs") : ""}</span>${st === "failed" ? (doc.state === "failed" ? "Failed" : "Rejected") : label}</li>`;
  })}</ol>`;
};

export type Doc = import("../data/types.js").InboxDoc;

const ACCEPT = { pdf: "PDF", png: "Image", jpg: "Image", jpeg: "Image", txt: "Text", eml: "Email", csv: "CSV" };
const MAX_BYTES = 15 * 1024 * 1024;
export const DOC_STATE = (({
  uploaded: { label: "Uploaded", level: "excess", icon: "upload" },
  processing: { label: "Processing", level: "info", icon: "refresh" },
  needs_review: { label: "Needs review", level: "warning", icon: "alert" },
  verified: { label: "Verified", level: "healthy", icon: "checkCircle" },
  failed: { label: "Failed", level: "critical", icon: "x" },
  rejected: { label: "Rejected", level: "excess", icon: "x" },
}) as Record<string, {label: string, level: string, icon: import("../lib/icons.js").IconName}>);

const stateBadge = (s: string) => { const v = DOC_STATE[s]; return html`<span class="status status-${v.level}">${icon(v.icon)}${v.label}</span>`; };

const methodTag = (doc: Doc) => doc.method === "simulated" ? html`<span class="prov prov-ai">Simulated extraction · sample fixture</span>`
  : doc.method === "rules" ? html`<span class="prov prov-calc">Rule-based text parsing, no model</span>`
  : doc.method === "manual" ? html`<span class="prov prov-sample">Entered by hand</span>` : "";

export function mountInbox(root: HTMLElement) {
  const id = store.get().routeSub;
  return id ? mountReview(root, id) : mountList(root);
}

// ---- list + intake ----------------------------------------------------------------------------

function mountList(root: HTMLElement) {
  document.title = "Supplier Inbox · StockPulse AMD";
  const f = { state: "all", supplier: store.get().routeParams.supplier || "all" };
  let feedback: {name: string, ok: boolean, msg: string}[] = [];
  let pasteOpen = false;
  let shownDocs: Set<string> | null = null;

  function render() {
    const s = store.get();
    const d = s.data;
    const sup = Object.fromEntries((d?.suppliers || []).map((x) => [x.supplier_id, x.name]));
    const docs = [...s.docs].sort((a, b) => +new Date(b.received_at) - +new Date(a.received_at))
      .filter((x) => (f.state === "all" || x.state === f.state) && (f.supplier === "all" || x.supplier_id === f.supplier));
    const open = s.docs.filter((x) => ["uploaded", "needs_review", "failed"].includes(x.state)).length;
    setHTML(root, html`
      ${pageHead({ title: "Supplier Inbox", sub: "Price lists, invoices, catalogs and delay notices. Values read from documents change nothing until a person reviews and confirms them." })}
      <div class="inbox-top">
        <section class="panel" aria-labelledby="intake-title">
          <div class="panel-head"><div><h2 class="panel-title" id="intake-title">Add documents</h2><p class="panel-sub">PDF, image, email (.eml, .txt) up to 15 MB. Sales and inventory CSVs go to the data import.</p></div></div>
          <div class="panel-body">
            <label class="dropzone" data-drop>
              ${icon("upload")}<strong>Drop supplier documents here or choose files</strong>
              <small>Files stay in this browser; nothing is uploaded to a server in this demo.</small>
              <input class="visually-hidden" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt,.eml,.csv" data-file>
            </label>
            ${feedback.length ? html`<ul class="file-list" aria-live="polite" style="margin-top:12px">${feedback.map((x) => html`<li class="file-row"><span style="color:${x.ok ? "var(--green-ink)" : "var(--red-ink)"}">${icon(x.ok ? "fileCheck" : "fileX")}</span><span><b>${x.name}</b><small>${x.msg}</small></span><span></span></li>`)}</ul>` : ""}
            <div class="paste">
              <button class="btn btn-link btn-sm" type="button" data-paste-toggle aria-expanded="${pasteOpen}">${pasteOpen ? "Hide" : "Or paste a supplier email"}</button>
              ${pasteOpen ? html`<label class="visually-hidden" for="paste-text">Email text</label>
                <textarea class="input textarea" id="paste-text" rows="5" placeholder="Paste the email body. Supplier names, lead times and “Product … $1.23” prices are picked out by simple rules for you to review."></textarea>
                <div class="row-actions"><button class="btn btn-secondary btn-sm" type="button" data-paste-add>Read pasted email</button></div>` : ""}
            </div>
          </div>
        </section>
        <section class="panel ai-note" aria-labelledby="ai-title">
          <div class="panel-head"><div><h2 class="panel-title" id="ai-title">Document intelligence</h2></div>${prov("ai")}</div>
          <div class="panel-body">
            <p>Designed for a multimodal model (for example Qwen2.5-VL) served on AMD Instinct GPUs with ROCm, returning structured fields with a confidence for each value.</p>
            <p class="callout"><b>Not connected in this demo.</b> Sample documents show simulated extraction from fixture data. Your own files can be reviewed by entering values by hand, and pasted emails are read by simple rules. No GPU status or inference metrics are shown because none are running.</p>
            <dl class="kv"><div><dt>Waiting for you</dt><dd class="num">${open}</dd></div><div><dt>Verified</dt><dd class="num">${s.docs.filter((x) => x.state === "verified").length}</dd></div></dl>
          </div>
        </section>
      </div>
      <section class="panel" aria-labelledby="docs-title">
        <div class="panel-head"><div><h2 class="panel-title" id="docs-title">Documents</h2></div>
          <div class="toolbar" style="padding:0">
            ${filterSelect("state", "State", [{ value: "all", label: "All states" }, ...Object.entries(DOC_STATE).map(([k, v]) => ({ value: k, label: v.label }))], f.state)}
            ${filterSelect("supplier", "Supplier", [{ value: "all", label: "All suppliers" }, ...(d?.suppliers || []).map((x) => ({ value: x.supplier_id, label: x.name }))], f.supplier)}
          </div></div>
        ${docs.length ? html`<div class="table-wrap"><table class="ptable" style="min-width:860px">
          <thead><tr><th scope="col">Document</th><th scope="col">Supplier</th><th scope="col">Type</th><th scope="col">Received</th><th scope="col">State</th><th scope="col" class="r">Fields</th><th scope="col">Review</th></tr></thead>
          <tbody>${docs.map((x) => {
            const issues = d ? x.lines.filter((l) => l.include).flatMap((l) => lineIssues(l, x, d)).filter((i) => i.level === "error").length : 0;
            return html`<tr data-doc="${x.id}" tabindex="0" aria-label="${x.name}, ${DOC_STATE[x.state].label}. Open">
              <td><div class="prod"><strong class="doc-name">${icon(x.type === "email" ? "inbox" : "file", "icon-sm")}${x.name}</strong><small>${x.origin === "fixture" ? "Sample document" : x.origin === "paste" ? "Pasted text" : `Your file · ${Math.round((x.size || 0) / 1024)} KB`}</small></div></td>
              <td>${x.supplier_id ? sup[x.supplier_id] || x.supplier_id : html`<span class="muted">Unknown</span>`}</td>
              <td>${DOC_TYPE_LABEL[x.type]}</td>
              <td class="num">${shortDate(new Date(x.received_at))}, ${new Date(x.received_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</td>
              <td>${stateBadge(x.state)}</td>
              <td class="r num">${x.lines.length ? fieldCount(x.lines) : html`<span class="dash">-</span>`}</td>
              <td>${x.state === "needs_review" ? (issues ? html`<span class="txt-critical">${plural(issues, "issue")} to fix</span>` : "Ready to confirm") : x.state === "verified" ? html`<span class="muted">Confirmed ${x.verified_at ? shortDate(new Date(x.verified_at)) : ""}</span>` : x.state === "uploaded" ? "Not processed" : x.state === "failed" ? html`<span class="txt-critical">Needs manual entry</span>` : html`<span class="muted">-</span>`}</td>
            </tr>`;
          })}</tbody></table></div>`
          : emptyState({ title: "No documents match", body: "Change the filters or add a document above.", iconName: "inbox" })}
        <div class="table-foot"><span>${plural(s.docs.length, "document")}</span><button class="btn btn-link btn-sm" type="button" data-reset-inbox>Restore sample documents</button></div>
      </section>`);
    const before = shownDocs;
    shownDocs = new Set(s.docs.map((x) => x.id));
    if (before) {
      const fresh = [...root.querySelectorAll("tr[data-doc]")].filter((tr) => !before.has(((tr as HTMLElement).dataset.doc as string)));
      if (fresh.length) { enterBlock(fresh); highlight(fresh, "indigo"); }
    }
  }

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    feedback = [];
    const added: Doc[] = [];
    let csv = false;
    for (const file of Array.from(files)) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!(ext in ACCEPT)) { feedback.push({ name: file.name, ok: false, msg: `“.${ext}” isn't supported. Use PDF, PNG, JPG, TXT, EML or CSV.` }); continue; }
      if (file.size > MAX_BYTES) { feedback.push({ name: file.name, ok: false, msg: "Larger than 15 MB." }); continue; }
      if (file.size === 0) { feedback.push({ name: file.name, ok: false, msg: "The file is empty." }); continue; }
      if (ext === "csv") { csv = true; feedback.push({ name: file.name, ok: true, msg: "CSV: opened in the data import so it can be checked against the schema." }); continue; }
      const d = store.get().data;
      const text = ext === "txt" || ext === "eml" ? await file.text() : "";
      const parsed = text && d ? parseEmail(text, d) : null;
      const supGuess = parsed?.supplier_id || (d?.suppliers.find((x) => file.name.toLowerCase().includes(x.name.toLowerCase().split(" ")[0])) || null)?.supplier_id || null;
      added.push({
        id: `doc-${Date.now().toString(36)}-${added.length}`, name: file.name, supplier_id: supGuess,
        type: ext === "eml" || ext === "txt" ? "email" : /invoice|inv/i.test(file.name) ? "invoice" : /price/i.test(file.name) ? "price_list" : /catalog/i.test(file.name) ? "catalog" : "other",
        received_at: new Date().toISOString(), state: parsed?.lines.length ? "needs_review" : "uploaded", origin: "upload",
        method: parsed?.lines.length ? "rules" : null, size: file.size, text: text.slice(0, 4000), lines: parsed?.lines || [],
      });
      feedback.push({ name: file.name, ok: true, msg: parsed?.lines.length ? `Uploaded. Rules found ${plural(parsed.lines.length, "value")} to review.` : "Uploaded. Not processed: no extraction service is connected." });
    }
    if (added.length) store.set({ docs: [...added, ...store.get().docs] });
    render();
    enterBlock(root.querySelectorAll(".file-list .file-row"), { stagger: 40 });
    if (csv) openImport();
  }

  on(root, "change", "[data-file]", (_e, t) => handle((t as HTMLInputElement).files));
  on(root, "dragover", "[data-drop]", (e, t) => { e.preventDefault(); t.classList.add("is-over"); });
  on(root, "dragleave", "[data-drop]", (_e, t) => t.classList.remove("is-over"));
  on(root, "drop", "[data-drop]", (e, t) => { e.preventDefault(); t.classList.remove("is-over"); handle((e as DragEvent).dataTransfer?.files || null); });
  on(root, "click", "[data-paste-toggle]", () => { pasteOpen = !pasteOpen; render(); if (pasteOpen) (($("#paste-text", root)) as HTMLElement | null)?.focus(); });
  on(root, "click", "[data-paste-add]", () => {
    const text = (($("#paste-text", root)) as HTMLTextAreaElement | null)?.value.trim() || "";
    const d = store.get().data;
    if (!text || !d) { toast("Paste some email text first"); return; }
    const parsed = parseEmail(text, d);
    const doc = (({ id: `doc-${Date.now().toString(36)}`, name: text.split("\n")[0].slice(0, 70) || "Pasted email", supplier_id: parsed.supplier_id, type: "email",
      received_at: new Date().toISOString(), state: "needs_review", origin: "paste", method: parsed.lines.length ? "rules" : "manual", text: text.slice(0, 4000),
      lines: parsed.lines.length ? parsed.lines : [blankLine("supplier")] }) as Doc);
    store.set({ docs: [doc, ...store.get().docs] });
    go(`inbox/${doc.id}`);
  });
  on(root, "change", "[data-filter-select]", (_e, t) => { (f as Record<string, string>)[t.dataset.filterSelect as string] = (t as HTMLSelectElement).value; render(); });
  on(root, "click", "tr[data-doc]", (_e, t) => go(`inbox/${t.dataset.doc}`));
  on(root, "keydown", "tr[data-doc]", (e, t) => { if ((e as KeyboardEvent).key === "Enter") go(`inbox/${t.dataset.doc}`); });
  on(root, "click", "[data-reset-inbox]", () => { store.set({ docs: INBOX_FIXTURES.map((x) => ({ ...x, lines: x.lines.map((l) => ({ ...l })) })) }); toast("Sample documents restored. Confirmed values stay applied until reverted in Settings."); });

  render();
  const unsub = store.subscribe((_s, ch) => { if (ch.has("docs") || ch.has("data")) render(); });
  return () => unsub();
}

const blankLine = (kind: "item" | "supplier"): import("../data/types.js").ExtractedLine => ({ id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind, text: "Entered by hand", sku: null, fields: kind === "item" ? { unit_cost: null, moq: null, pack_size: null, effective: null } : { lead_time_days: null, effective: null }, conf: {}, ref: "Manual entry", include: true, edited: true });

// ---- review ---------------------------------------------------------------------------------------

function mountReview(root: HTMLElement, id: string) {
  let busy = false;
  let confirmed: import("../data/types.js").ConfirmedUpdate[] = [];
  let shownState = (null as string | null);

  const getDoc = () => store.get().docs.find((x) => x.id === id);

  /** Motion only when the document's state really changed since the last render. */
  function animateState() {
    const doc = getDoc();
    if (!doc) return;
    const was = shownState;
    shownState = doc.state;
    if (doc.state === "processing") {
      const bar = (root.querySelector("[data-sim-bar]") as HTMLElement | null);
      const started = Number(doc.processing_started || Date.now());
      const left = Math.max(0, SIM_MS - (Date.now() - started));
      if (bar) animate(bar, { width: [`${Math.min(100, ((SIM_MS - left) / SIM_MS) * 100)}%`, "100%"], duration: left, ease: "linear" });
    }
    if (!was || was === doc.state) return;
    confirmState(root.querySelector(".page-sub .status"));
    confirmState(root.querySelector(".step[aria-current] .step-dot"));
    if (doc.state === "needs_review") enterBlock(root.querySelectorAll(".rline"), { stagger: 45, max: 6 });
    if (doc.state === "verified") { enterBlock(root.querySelectorAll(".change-list li")); highlight(root.querySelectorAll(".page-sub .status")[0] || [], "green"); }
  }

  async function fetchConfirmed() {
    const doc = getDoc();
    if (doc?.state !== "verified") return;
    try { confirmed = (await listUpdates(true)).updates.filter((u) => u.source_doc === doc.name); } catch { confirmed = []; }
    render();
  }

  function render() {
    const s = store.get();
    const doc = getDoc();
    const back = html`<a class="back-link" href="#/inbox">${icon("chevronRight", "icon-xs flip")}Supplier Inbox</a>`;
    if (!doc) { setHTML(root, html`${back}<div class="panel">${emptyState({ title: "Document not found", body: "It may have been removed when the sample inbox was restored.", iconName: "inbox" })}</div>`); return; }
    document.title = `${doc.name} · Supplier Inbox`;
    const d = s.data;
    if (!d) { setHTML(root, html`${back}<div class="panel">${emptyState({ title: "Loading…", iconName: "refresh" })}</div>`); return; }
    const supName = doc.supplier_id ? d.suppliers.find((x) => x.supplier_id === doc.supplier_id)?.name : null;
    const included = doc.lines.filter((l) => l.include);
    const issues = included.map((l) => ({ l, iss: lineIssues(l, doc, d) }));
    const errors = issues.reduce((a, x) => a + x.iss.filter((i) => i.level === "error").length, 0);
    const changes = included.flatMap((l) => (lineIssues(l, doc, d).some((i) => i.level === "error") ? [] : lineChanges(l, doc, d)));
    const keep = (document.activeElement as HTMLElement | null)?.dataset?.key;

    setHTML(root, html`
      ${back}
      ${pageHead({ title: doc.name, sub: html`${stateBadge(doc.state)} <span class="muted">${DOC_TYPE_LABEL[doc.type]} · ${supName || "supplier not identified"} · received ${shortDate(new Date(doc.received_at))}</span> ${methodTag(doc)}` })}
      ${stepper(doc)}
      ${!doc.supplier_id && doc.state !== "verified" ? html`<section class="panel"><div class="panel-body" style="padding-top:16px"><div class="field">
        <label for="doc-sup">Which supplier sent this?</label>
        <select class="select" id="doc-sup" data-doc-sup><option value="">Choose a supplier</option>${d.suppliers.map((x) => html`<option value="${x.supplier_id}">${x.name}</option>`)}</select></div></div></section>` : ""}
      ${doc.state === "uploaded" ? html`<section class="panel"><div class="state">${icon("file")}<strong>Not processed yet</strong>
          <span>${doc.origin === "fixture" ? "This sample runs through simulated extraction, which returns fixture data for the review step." : "No extraction service is connected, so nothing can read this file automatically. Enter the values you see in it."}</span>
          <div class="row-actions">${doc.origin === "fixture" ? html`<button class="btn btn-primary" type="button" data-run>${icon("scan", "icon-sm")}Run simulated extraction</button>` : ""}
            <button class="btn ${doc.origin === "fixture" ? "btn-secondary" : "btn-primary"}" type="button" data-manual>Enter values by hand</button></div></div></section>`
      : doc.state === "processing" ? html`<section class="panel"><div class="state" role="status">${icon("refresh")}<strong>Processing…</strong><span>Simulated extraction of ${doc.name} (sample fixture, no model is running). Values appear for review; nothing is applied yet.</span>
          <div class="sim-progress" aria-hidden="true"><i data-sim-bar></i></div></div></section>`
      : doc.state === "failed" ? html`<section class="panel"><div class="state" role="alert">${icon("alert")}<strong>Extraction failed</strong><span>${doc.error || "The document could not be read."}</span>
          <button class="btn btn-primary" type="button" data-manual>Enter values by hand</button></div></section>`
      : doc.state === "verified" ? verifiedView(doc, confirmed, d)
      : doc.state === "rejected" ? html`<section class="panel"><div class="state">${icon("x")}<strong>Rejected</strong><span>Nothing from this document was applied.</span><button class="btn btn-secondary" type="button" data-reopen>Reopen for review</button></div></section>`
      : html`
        <section class="panel" aria-labelledby="rev-title">
          <div class="panel-head"><div><h2 class="panel-title" id="rev-title">Review extracted values</h2>
            <p class="panel-sub">Check each value against the source. Confidence under ${pct(CONF_THRESHOLD, 0)} is flagged. Edit anything that's wrong; exclude lines you don't want applied.</p></div>
            <div class="row-actions"><button class="btn btn-secondary btn-sm" type="button" data-add-line="item">${icon("plus", "icon-xs")}Product line</button><button class="btn btn-secondary btn-sm" type="button" data-add-line="supplier">${icon("plus", "icon-xs")}Lead-time line</button></div></div>
          ${doc.text ? html`<details class="source-text"><summary>Source text</summary><pre>${doc.text}</pre></details>` : ""}
          <div class="review-lines">${doc.lines.map((l) => reviewLine(l, doc, d))}</div>
          <div class="panel-foot review-foot">
            <span>${errors ? html`<span class="txt-critical">${icon("octagon", "icon-xs")} ${plural(errors, "problem")} to fix or exclude</span>` : html`${plural(changes.length, "change")} to trusted data`}</span>
            <span class="row-actions">
              <button class="btn btn-ghost" type="button" data-reject>Reject document</button>
              <button class="btn btn-primary" type="button" data-confirm ${errors || !changes.length || busy || !doc.supplier_id ? "disabled" : ""}>${busy ? "Applying…" : changes.length ? `Confirm ${plural(changes.length, "change")}` : "No changes to confirm"}</button>
            </span>
          </div>
        </section>
        ${changes.length && !errors ? html`<section class="panel"><div class="panel-head"><div><h2 class="panel-title">What confirming will change</h2><p class="panel-sub">Forecast-driven orders, costs and risks recalculate with these values.</p></div>${prov("calc")}</div>
          <ul class="change-list panel-body">${changes.map((c) => html`<li><b>${c.sku ? d.products.find((p) => p.sku === c.sku)?.name : supName}</b> ${fieldName(c.field)}: <span class="num">${fmtField(c.field, c.old_value)}</span> → <b class="num">${fmtField(c.field, c.new_value)}</b>${c.effective ? html` <span class="muted">from ${c.effective}</span>` : ""}</li>`)}</ul></section>` : ""}`}`);
    if (keep) (root.querySelector(`[data-key="${keep}"]`) as HTMLElement | null)?.focus();
    animateState();
  }

  function reviewLine(l: import("../data/types.js").ExtractedLine, doc: Doc, d: import("../data/types.js").Dashboard) {
    const iss = l.include ? lineIssues(l, doc, d) : [];
    const has = (f: string) => iss.find((i) => i.field === f && i.level !== "info");
    const conf = (f: string) => (l.conf[f] != null ? html`<span class="conf ${l.conf[f] < CONF_THRESHOLD ? "is-low" : ""}" title="Extraction confidence">${pct(l.conf[f], 0)}</span>` : "");
    const opts = d.products.filter((p) => !doc.supplier_id || p.supplier_id === doc.supplier_id);
    const num = (f: string, label: string, step: string = "1") => html`<label class="rf ${has(f) ? `is-${has(f)?.level}` : ""}"><span>${label} ${conf(f)}</span>
      <input class="input num" type="number" min="0" step="${step}" value="${(l.fields as Record<string, number | string | null | undefined>)[f] ?? ""}" data-field="${f}" data-line="${l.id}" data-key="${l.id}-${f}" ${l.include ? "" : "disabled"}></label>`;
    return html`<article class="rline ${l.include ? "" : "is-excluded"} ${iss.some((i) => i.level === "error") ? "has-error" : ""}" aria-label="${l.text}">
      <header>
        <label class="incl"><input type="checkbox" class="checkbox" data-include="${l.id}" ${l.include ? "checked" : ""}> Apply</label>
        <span class="rtext">${l.text}</span>
        <span class="muted rref">${l.ref}${l.edited ? " · edited" : ""}</span>
      </header>
      <div class="rfields">
        ${l.kind === "item" ? html`
          <label class="rf wide ${has("sku") ? `is-${has("sku")?.level}` : ""}"><span>Matched product ${conf("sku")}</span>
            <select class="select" data-field="sku" data-line="${l.id}" data-key="${l.id}-sku" ${l.include ? "" : "disabled"}><option value="">No match</option>${opts.map((p) => html`<option value="${p.sku}" ${p.sku === l.sku ? "selected" : ""}>${p.name} · ${p.sku}</option>`)}</select></label>
          ${num("unit_cost", "Unit cost ($)", "0.01")}${num("moq", "MOQ")}${num("pack_size", "Case pack")}`
        : html`<label class="rf"><span>Supplier</span><input class="input" type="text" value="${doc.supplier_id ? d.suppliers.find((x) => x.supplier_id === doc.supplier_id)?.name : "Choose above"}" disabled></label>${num("lead_time_days", "Lead time (days)")}`}
        <label class="rf ${has("effective") ? `is-${has("effective")?.level}` : ""}"><span>Effective date ${conf("effective")}</span>
          <input class="input" type="date" value="${l.fields.effective || ""}" data-field="effective" data-line="${l.id}" data-key="${l.id}-effective" ${l.include ? "" : "disabled"}></label>
      </div>
      ${iss.length ? html`<ul class="riss">${iss.map((i) => html`<li class="issue issue-${i.level}">${icon(i.level === "error" ? "octagon" : i.level === "warning" ? "alert" : "info", "icon-xs")}${i.msg}</li>`)}</ul>` : ""}
    </article>`;
  }

  function verifiedView(doc: Doc, ups: import("../data/types.js").ConfirmedUpdate[], d: import("../data/types.js").Dashboard) {
    return html`<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Applied to trusted data</h2>
      <p class="panel-sub">Confirmed ${doc.verified_at ? shortDate(new Date(doc.verified_at)) : ""}. Every forecast-driven order, cost and risk now uses these values.</p></div>${prov("calc")}</div>
      ${ups.length ? html`<ul class="change-list panel-body">${ups.map((u) => html`<li class="${u.reverted_at ? "is-reverted" : ""}"><b>${u.sku ? html`<button class="btn btn-link" type="button" data-action="open-sku" data-arg="${u.sku}">${d.products.find((p) => p.sku === u.sku)?.name || u.sku}</button>` : "Supplier"}</b> ${fieldName(u.field)}: ${fmtField(u.field, u.old_value)} → <b>${fmtField(u.field, u.new_value)}</b>
        ${u.reverted_at ? html`<span class="muted"> · reverted</span>` : html`<button class="btn btn-link btn-sm" type="button" data-revert="${u.id}">Revert</button>`}</li>`)}</ul>`
        : html`<p class="panel-body muted">Loading confirmed values…</p>`}
      ${(() => {
        const affected = d.products.filter((p) => p.supplier_id === doc.supplier_id && (ups.some((u) => u.sku === p.sku && !u.reverted_at) || ups.some((u) => !u.sku && !u.reverted_at)) && p.reasons.includes("STOCKOUT_RISK"));
        return affected.length ? html`<div class="callout callout-critical" style="margin:0 20px 16px"><b>Now at risk with the confirmed terms:</b> ${affected.map((p, i) => html`${i ? ", " : ""}<button class="btn btn-link" type="button" data-action="open-sku" data-arg="${p.sku}">${p.name}</button>`)}.
          <a href="#/cart?sku=${affected[0].sku}">Review in the Purchasing Cart</a></div>` : "";
      })()}
      <div class="panel-foot"><span class="muted">${doc.supplier_id ? html`<a href="#/risk?supplier=${doc.supplier_id}">See this supplier's risks</a>` : ""}</span><a class="btn btn-secondary btn-sm" href="#/cart">Open Purchasing Cart</a></div></section>`;
  }

  const editLine = (lineId: string, fn: (l: import("../data/types.js").ExtractedLine) => import("../data/types.js").ExtractedLine) => { const doc = getDoc(); if (doc) updateDoc(id, { lines: doc.lines.map((l) => (l.id === lineId ? fn(l) : l)) }); };

  on(root, "change", "[data-field]", (_e, t) => {
    const f = (t.dataset.field as string), v = (t as HTMLInputElement).value;
    editLine((t.dataset.line as string), (l) => f === "sku"
      ? { ...l, sku: v || null, edited: true, conf: { ...l.conf, sku: v ? 1 : 0 } }
      : { ...l, edited: true, conf: Object.fromEntries(Object.entries(l.conf).filter(([k]) => k !== f)), fields: { ...l.fields, [f]: f === "effective" ? (v || null) : v === "" ? null : Number(v) } });
  });
  on(root, "change", "[data-include]", (_e, t) => editLine((t.dataset.include as string), (l) => ({ ...l, include: (t as HTMLInputElement).checked })));
  on(root, "change", "[data-doc-sup]", (_e, t) => updateDoc(id, { supplier_id: (t as HTMLSelectElement).value || null }));
  on(root, "click", "[data-add-line]", (_e, t) => { const doc = getDoc(); if (doc) updateDoc(id, { lines: [...doc.lines, blankLine((t.dataset.addLine as "item" | "supplier"))] }); });
  on(root, "click", "[data-run]", () => {
    updateDoc(id, { state: "processing", method: "simulated", processing_started: Date.now() });
    window.setTimeout(() => {
      const doc = getDoc();
      if (doc?.state === "processing") updateDoc(id, { state: "needs_review", lines: (doc.fixtureLines || []).map((l) => ({ ...l })) });
    }, SIM_MS);
  });
  on(root, "click", "[data-manual]", () => updateDoc(id, { state: "needs_review", method: "manual", lines: [blankLine(getDoc()?.type === "notice" ? "supplier" : "item")] }));
  on(root, "click", "[data-reject]", () => { updateDoc(id, { state: "rejected" }); toast("Document rejected. Nothing was applied."); });
  on(root, "click", "[data-reopen]", () => updateDoc(id, { state: "needs_review" }));
  on(root, "click", "[data-confirm]", async () => {
    const doc = getDoc();
    const d = store.get().data;
    if (!doc || !d) return;
    const changes = doc.lines.filter((l) => l.include && !lineIssues(l, doc, d).some((i) => i.level === "error")).flatMap((l) => lineChanges(l, doc, d));
    if (!changes.length) return;
    busy = true;
    render();
    try {
      const res = await confirmUpdates(changes);
      updateDoc(id, { state: "verified", verified_at: new Date().toISOString(), confirmed_ids: res.confirmed.map((u: {id: number}) => u.id) });
      await load();
      toast(`${plural(changes.length, "change")} applied. Forecast-driven orders and risks recalculated.`);
      fetchConfirmed();
    } catch (e) {
      toast(`Not applied: ${e instanceof Error ? e.message : e}`);
    }
    busy = false;
    render();
  });
  on(root, "click", "[data-revert]", async (_e, t) => {
    try { await revertUpdate(Number(t.dataset.revert)); await load(); toast("Reverted. Calculations use the previous value again."); fetchConfirmed(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  });

  render();
  fetchConfirmed();
  const unsub = store.subscribe((_s, ch) => { if (ch.has("docs") || ch.has("data")) render(); });
  return () => unsub(); // a running simulated extraction finishes even if the page is left
}

const fieldName = (f: string) => ({ unit_cost: "unit cost", moq: "MOQ", pack_size: "case pack", lead_time_days: "lead time", min_order_value: "minimum order" })[f] || f;

const fmtField = (f: string, v: number | null) => (v == null ? "-" : f === "unit_cost" || f === "min_order_value" ? cents(v) : f === "lead_time_days" ? `${int(v)} days` : int(v));
