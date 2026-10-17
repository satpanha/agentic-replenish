/** Supplier-document review: checks on extracted lines and the changes they would make. */
import { cents, pct } from "../lib/format.js";

export const CONF_THRESHOLD = 0.8;

export type LineIssue = {field: string, level: "error" | "warning" | "info", msg: string};

export function lineIssues(l: import("./types.js").ExtractedLine, doc: import("./types.js").InboxDoc, d: import("./types.js").Dashboard): LineIssue[] {
  const out: LineIssue[] = [];
  const f = l.fields;
  if (l.kind === "item") {
    const p = l.sku ? d.products.find((x) => x.sku === l.sku) : null;
    if (!l.sku) out.push({ field: "sku", level: "error", msg: "No matching product: choose a SKU or exclude this line." });
    else if (!p) out.push({ field: "sku", level: "error", msg: `${l.sku} is not in the catalogue.` });
    else if (doc.supplier_id && p.supplier_id !== doc.supplier_id) out.push({ field: "sku", level: "error", msg: `${p.name} is bought from a different supplier.` });
    if (f.unit_cost == null || !(f.unit_cost > 0)) out.push({ field: "unit_cost", level: "error", msg: "Unit cost is missing or not positive." });
    for (const k of ((["moq", "pack_size"]) as const)) {
      const v = f[k];
      if (v == null) continue;
      if (!Number.isInteger(v) || v < (k === "pack_size" ? 1 : 1)) out.push({ field: k, level: "error", msg: `${k === "moq" ? "MOQ" : "Case pack"} must be a whole number of at least 1 (read “${v}”).` });
    }
    if (f.moq && f.pack_size && Number.isInteger(f.moq) && Number.isInteger(f.pack_size) && f.moq % f.pack_size) {
      out.push({ field: "moq", level: "warning", msg: `MOQ ${f.moq} is not a whole number of cases of ${f.pack_size}.` });
    }
    if (p && f.unit_cost != null && f.unit_cost > 0 && Math.abs(f.unit_cost - p.unit_cost) / p.unit_cost > 0.005) {
      const ch = (f.unit_cost - p.unit_cost) / p.unit_cost;
      out.push(doc.type === "invoice"
        ? { field: "unit_cost", level: "warning", msg: `Invoice price ${cents(f.unit_cost)} conflicts with the trusted cost ${cents(p.unit_cost)}. Confirm only if the supplier changed its price.` }
        : { field: "unit_cost", level: "info", msg: `Changes trusted cost ${cents(p.unit_cost)} → ${cents(f.unit_cost)} (${ch > 0 ? "+" : ""}${(ch * 100).toFixed(1)}%).` });
    }
    if (p && f.pack_size != null && Number.isInteger(f.pack_size) && f.pack_size !== p.pack_size) out.push({ field: "pack_size", level: "warning", msg: `Case pack differs from the trusted ${p.pack_size}.` });
  } else {
    if (f.lead_time_days == null || !(f.lead_time_days > 0) || !Number.isInteger(f.lead_time_days)) out.push({ field: "lead_time_days", level: "error", msg: "Lead time must be a whole number of days." });
  }
  if (!f.effective) out.push({ field: "effective", level: "error", msg: "Effective date is required before this can change trusted data." });
  for (const [k, c] of Object.entries(l.conf || {})) {
    if (c < CONF_THRESHOLD && !(l.edited && k !== "sku")) out.push({ field: k, level: "warning", msg: k === "sku" && !l.sku ? "" : `Low extraction confidence (${pct(c, 0)}): check against the source.` });
  }
  return out.filter((i) => i.msg);
}

/** Field changes a confirmed line would write. */
export function lineChanges(l: import("./types.js").ExtractedLine, doc: import("./types.js").InboxDoc, d: import("./types.js").Dashboard) {
  const out: {supplier_id: string, sku?: string, field: string, old_value: number | null, new_value: number, effective: string | null, source_doc: string, source_ref: string}[] = [];
  const base = { effective: l.fields.effective || null, source_doc: doc.name, source_ref: l.ref };
  if (l.kind === "item") {
    const p = d.products.find((x) => x.sku === l.sku);
    if (!p) return out;
    for (const k of ((["unit_cost", "moq", "pack_size"]) as const)) {
      const v = l.fields[k];
      if (v != null && v !== p[k]) out.push({ supplier_id: p.supplier_id, sku: p.sku, field: k, old_value: p[k], new_value: v, ...base });
    }
  } else if (doc.supplier_id) {
    const s = d.suppliers.find((x) => x.supplier_id === doc.supplier_id);
    const v = l.fields.lead_time_days;
    if (s && v != null && v !== s.lead_time_days) out.push({ supplier_id: s.supplier_id, field: "lead_time_days", old_value: s.lead_time_days, new_value: v, ...base });
  }
  return out;
}

export const fieldCount = (lines: import("./types.js").ExtractedLine[]) => lines.reduce((a, l) => a + Object.values(l.fields).filter((v) => v != null && v !== "").length + (l.sku ? 1 : 0), 0);

/**
 * Rule-based reading of pasted email text (no model): finds the supplier, a lead time and
 * "<product> ... $1.23" price mentions. Everything it returns still goes through review.
 */
export function parseEmail(text: string, d: import("./types.js").Dashboard): {supplier_id: string | null, lines: import("./types.js").ExtractedLine[]} {
  const t = text.toLowerCase();
  const sup = d.suppliers.find((s) => t.includes(s.name.toLowerCase()) || s.name.toLowerCase().split(" ").filter((w) => w.length > 4).some((w) => t.includes(w)));
  const lines: import("./types.js").ExtractedLine[] = [];
  const lt = text.match(/(?:lead[\s-]?time|deliver(?:y|ies)|take|delay)[^.\n]{0,60}?(\d{1,3})\s*(?:business\s+)?days?/i);
  if (lt) lines.push({ id: "r-lt", kind: "supplier", text: lt[0].trim(), sku: null, fields: { lead_time_days: Number(lt[1]), effective: null }, conf: {}, ref: "Pasted text", include: true });
  d.products.filter((p) => !sup || p.supplier_id === sup.supplier_id).forEach((p) => {
    const re = new RegExp(`${p.name.split(" ")[0]}[^\\n$]{0,40}\\$\\s?(\\d+(?:\\.\\d{1,2})?)`, "i");
    const m = text.match(re);
    if (m) lines.push({ id: `r-${p.sku}`, kind: "item", text: m[0].trim(), sku: p.sku, fields: { unit_cost: Number(m[1]), effective: null }, conf: {}, ref: "Pasted text", include: true });
  });
  return { supplier_id: sup?.supplier_id || null, lines };
}
