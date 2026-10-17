/**
 * Import Data. CSVs are checked by the engine against the canonical schema and cross-table rules;
 * only a clean check enables the import, which replaces the active dataset and recalculates everything.
 */
import { $, html, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { int } from "../lib/format.js";
import { IMPORT_SCHEMA } from "../data/demo.js";
import { checkData, importData } from "../data/api.js";
import { go, load } from "../state.js";
import { toast } from "./overlay.js";
import { surfaceIn } from "../lib/motion.js";

let dlg: HTMLDialogElement | null = null;
const MAX_BYTES = 20_000_000;

/** Which canonical table a header belongs to. */
function detect(text: string) {
  const header = (text.split(/\r?\n/, 1)[0] || "").split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const scored = Object.entries(IMPORT_SCHEMA).map(([k, cols]) => ({ k, hit: cols.filter((c) => header.includes(c)).length / cols.length })).sort((a, b) => b.hit - a.hit);
  return scored[0].hit >= 0.5 ? scored[0].k : null;
}

export function openImport() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "dialog";
    dlg.setAttribute("aria-labelledby", "import-title");
    document.body.append(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg?.close(); });
  }
  const d = dlg;
  const files: Record<string, string> = {};
  const picked: {name: string, table: string | null, rows: number, msg?: string}[] = [];
  let check: import("../data/types.js").DataCheck | null = null;
  let busy = false;

  const paint = () => setHTML(d, html`
    <header class="dialog-head">
      <div><h2 id="import-title">Import data</h2><p class="panel-sub">Replace the sales, inventory or supplier tables the engine uses. Tables you don't upload are kept.</p></div>
      <button class="btn btn-icon" type="button" data-x aria-label="Close">${icon("x")}</button>
    </header>
    <div class="dialog-body">
      <label class="dropzone" data-drop>
        ${icon("upload")}<strong>Drop CSV files here or choose files</strong>
        <small>sales.csv, inventory.csv, suppliers.csv · up to 20 MB each</small>
        <input class="visually-hidden" type="file" accept=".csv,text/csv" multiple data-file>
      </label>
      ${picked.length ? html`<ul class="file-list" aria-live="polite">${picked.map((p) => {
        const t = p.table ? check?.tables[p.table] : undefined;
        const errs = t?.errors || [];
        const ok = p.table && check && !errs.length;
        return html`<li class="file-row">
          <span style="color:${!p.table || errs.length ? "var(--red-ink)" : ok ? "var(--green-ink)" : "var(--ink-2)"}">${icon(!p.table || errs.length ? "fileX" : "fileCheck")}</span>
          <span><b>${p.name}</b><small>${p.msg || (p.table ? `${p.table}.csv · ${int(p.rows)} rows${errs.length ? ` · ${errs.join(" ")}` : ""}` : "Header doesn't match sales, inventory or suppliers.")}</small></span>
          <span class="status status-${!p.table || errs.length ? "critical" : ok ? "healthy" : "excess"}">${!p.table ? "Unknown" : errs.length ? "Invalid" : ok ? "Valid" : "Checking"}</span></li>`;
      })}</ul>` : ""}
      ${check && check.errors.length ? html`<div class="callout callout-critical"><b>Can't import yet:</b><ul>${check.errors.map((e: string) => html`<li>${e}</li>`)}</ul></div>` : ""}
      ${check && check.ok ? html`<p class="callout callout-calc">${icon("checkCircle", "icon-xs")} Checked by the engine: ${Object.entries(check.tables).map(([k, v]) => `${k} ${v.source === "upload" ? `(new, ${int(v.rows ?? 0)} rows)` : "(kept)"}`).join(" · ")}. Importing recalculates forecasts, risks and orders.</p>` : ""}
      <div class="schema">
        <div><code>sales</code> ${IMPORT_SCHEMA.sales.join(", ")}</div>
        <div><code>inventory</code> ${IMPORT_SCHEMA.inventory.join(", ")}</div>
        <div><code>suppliers</code> ${IMPORT_SCHEMA.suppliers.join(", ")}</div>
      </div>
    </div>
    <footer class="dialog-foot">
      <span class="note">Supplier PDFs and emails go to the <a href="#/inbox" data-x>Supplier Inbox</a>.</span>
      <button class="btn btn-secondary" type="button" data-x>Cancel</button>
      <button class="btn btn-primary" type="button" data-go ${check?.ok && !busy ? "" : "disabled"}>${busy ? "Importing…" : "Import to engine"}</button>
    </footer>`);

  const handle = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const file of Array.from(list)) {
      if (!/\.csv$/i.test(file.name)) { picked.push({ name: file.name, table: null, rows: 0, msg: "Not a CSV. Supplier documents go to the Supplier Inbox." }); continue; }
      if (file.size > MAX_BYTES) { picked.push({ name: file.name, table: null, rows: 0, msg: "Larger than 20 MB." }); continue; }
      const text = await file.text();
      const table = detect(text);
      if (table) files[table] = text;
      for (let i = picked.length - 1; i >= 0; i--) if (picked[i].table && picked[i].table === table) picked.splice(i, 1);
      picked.push({ name: file.name, table, rows: Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1) });
    }
    check = null;
    paint();
    if (Object.keys(files).length) {
      try { check = await checkData(files); } catch (e) { check = { ok: false, errors: [e instanceof Error ? e.message : String(e)], tables: {} }; }
      paint();
    }
  };

  d.onclick = async (e) => {
    const t = (e.target as Element);
    if (t.closest("[data-x]")) d.close();
    if (t.closest("[data-go]") && check?.ok) {
      busy = true;
      paint();
      try {
        const res = await importData(files);
        d.close();
        await load();
        toast(`Imported. Engine now uses ${res.status.skus} SKUs and ${res.status.history_days} days of sales.`, { label: "View inventory", run: () => go("inventory") });
      } catch (err) {
        check = { ok: false, errors: [err instanceof Error ? err.message : String(err)], tables: check?.tables || {} };
        busy = false;
        paint();
      }
    }
  };
  d.onchange = (e) => { const t = (e.target as HTMLInputElement); if (t.matches("[data-file]")) handle(t.files); };
  d.ondragover = (e) => { if ((e.target as Element).closest("[data-drop]")) { e.preventDefault(); $("[data-drop]", d)?.classList.add("is-over"); } };
  d.ondragleave = () => $("[data-drop]", d)?.classList.remove("is-over");
  d.ondrop = (e) => { if ((e.target as Element).closest("[data-drop]")) { e.preventDefault(); $("[data-drop]", d)?.classList.remove("is-over"); handle(e.dataTransfer?.files || null); } };
  paint();
  if (!d.open) { d.showModal(); surfaceIn(d); }
}
