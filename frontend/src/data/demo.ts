/**
 * Front-end demo data: things the engine does not model (workspace identity, default budget,
 * sample supplier documents). Everything here is labelled "sample" or "simulated" in the UI.
 * Product numbers never live here; they come from /api/dashboard so every section agrees.
 */

export const WORKSPACE = {
  id: "pp-central",
  name: "Phnom Penh Central",
  initials: "PP",
  kind: "Demo store",
  address: ["Street 63, Boeung Keng Kang", "Phnom Penh, Cambodia"],
};

export const USER = { name: "Demo approver", initials: "DA", role: "Purchasing lead" };

/** Default weekly purchasing budget for the demo workspace (a setting, editable in Settings). */
export const WEEKLY_BUDGET = 12000;

/** Demo session clock: activity times are minutes after this local time on the data's as-of date. */
export const SESSION_START = { hour: 7, minute: 30 };

/** Canonical CSV schema the import checks against (app/data_sample/*.csv). */
export const IMPORT_SCHEMA = {
  sales: ["date", "sku", "units"],
  inventory: ["sku", "name", "category", "supplier_id", "stock", "on_order", "unit_cost", "unit_price", "pack_size", "moq", "shelf_life_days", "earliest_expiry_date"],
  suppliers: ["supplier_id", "name", "lead_time_days", "lead_time_std_days", "min_order_value"],
};

const item = (id: string, text: string, sku: string | null, fields: import("./types.js").ExtractedLine["fields"], conf: Record<string, number>, ref: string): import("./types.js").ExtractedLine => ({ id, kind: "item", text, sku, fields, conf, ref, include: true });

/** Sample supplier documents. `fixtureLines` is what the simulated extractor returns for each one,
deliberately including the problems review exists for: low confidence, an unmatched product,
a price that conflicts with trusted data, an invalid quantity and a missing required value. */
const FIXTURE_DOCS: import("./types.js").InboxDoc[] = [
  {
    id: "doc-angkor-pl", name: "Angkor_Beverage_Revised_Terms.pdf", supplier_id: "S2", type: "price_list",
    received_at: "2026-10-16T07:39", state: "needs_review", origin: "fixture", method: "simulated", size: 184_320,
    headlines: [
      { kind: "lead_time_change", new_lead_time_days: 8, effective: "orders placed from today", confidence: 0.9 },
      { kind: "price_change", sku: "SKU008", new_unit_cost: 1.36, effective: "today", confidence: 0.97 },
    ],
    lines: [], fixtureLines: [
      { id: "a0", kind: "supplier", text: "“Owing to fleet maintenance, standard delivery is 8 days from order until further notice.”", sku: null,
        fields: { lead_time_days: 8, effective: "2026-10-16" }, conf: { lead_time_days: 0.9, effective: 0.88 }, ref: "Page 1, delivery terms", include: true },
      item("a1", "Cola 330ml can, tray of 24", "SKU008", { unit_cost: 1.36, pack_size: 24, moq: 48, effective: "2026-10-16" }, { sku: 0.98, unit_cost: 0.97, pack_size: 0.99, moq: 0.95, effective: 0.93 }, "Page 1, row 4"),
      item("a2", "Green Tea 500ml PET", "SKU009", { unit_cost: 0.92, pack_size: 24, moq: 48, effective: "2026-10-16" }, { sku: 0.96, unit_cost: 0.95, pack_size: 0.97, moq: 0.94, effective: 0.93 }, "Page 1, row 7"),
      item("a3", "Mineral Water 1.5L", "SKU007", { unit_cost: 0.57, pack_size: 24, moq: 96, effective: "2026-10-16" }, { sku: 0.99, unit_cost: 0.98, pack_size: 0.98, moq: 0.96, effective: 0.93 }, "Page 1, row 2"),
      item("a4", "Energy Drink 250ml", "SKU011", { unit_cost: 1.11, pack_size: 24, moq: 48, effective: "2026-10-16" }, { sku: 0.93, unit_cost: 0.9, pack_size: 0.58, moq: 0.88, effective: 0.93 }, "Page 2, row 1"),
      item("a5", "Lychee Soda 330ml", null, { unit_cost: 1.05, pack_size: 24, moq: 48, effective: "2026-10-16" }, { sku: 0.0, unit_cost: 0.94, pack_size: 0.96, moq: 0.9, effective: 0.93 }, "Page 2, row 3"),
    ],
  },
  {
    id: "doc-siam-email", name: "Re: Port congestion, revised delivery schedule", supplier_id: "S5", type: "email",
    received_at: "2026-10-16T07:44", state: "needs_review", origin: "fixture", method: "simulated",
    headlines: [{ kind: "lead_time_change", new_lead_time_days: 17, effective: "orders placed from today", confidence: 0.91 }],
    lines: [], fixtureLines: [
      { id: "s1", kind: "supplier", text: "“…deliveries will take approximately 17 days from order until congestion at the port clears…”", sku: null,
        fields: { lead_time_days: 17, effective: "2026-10-16" }, conf: { lead_time_days: 0.91, effective: 0.74 }, ref: "Email body, paragraph 2", include: true },
    ],
  },
  {
    id: "doc-pphs-invoice", name: "INV-20931_PhnomPenhHousehold.pdf", supplier_id: "S3", type: "invoice",
    received_at: "2026-10-15T16:20", state: "uploaded", origin: "fixture", method: null, size: 96_256,
    lines: [], fixtureLines: [
      item("p1", "Dish Soap 750ml (10/cs)", "SKU014", { unit_cost: 6.95, pack_size: 10, moq: 0, effective: null }, { sku: 0.95, unit_cost: 0.83, pack_size: 0.92, moq: 0.62 }, "Page 1, line 3"),
      item("p2", "Trash Bags 30pc", "SKU016", { unit_cost: 8.0, pack_size: 10, moq: 10, effective: null }, { sku: 0.97, unit_cost: 0.96, pack_size: 0.95, moq: 0.9 }, "Page 1, line 5"),
    ],
  },
  {
    id: "doc-pcc-catalog", name: "PacificPersonalCare_Catalog_Q4.pdf", supplier_id: "S4", type: "catalog",
    received_at: "2026-10-14T10:05", state: "needs_review", origin: "fixture", method: "simulated", size: 2_412_544,
    lines: [], fixtureLines: [
      item("c1", "Hand Soap 250ml pump", "SKU023", { unit_cost: 5.31, pack_size: 6, moq: 24, effective: "2026-10-20" }, { sku: 0.94, unit_cost: 0.95, pack_size: 0.93, moq: 0.88, effective: 0.86 }, "Page 14, item 3"),
      item("c2", "Shampoo Daily Care 400ml", "SKU021", { unit_cost: 7.15, pack_size: 6, moq: 6, effective: null }, { sku: 0.79, unit_cost: 0.92, pack_size: 0.9, moq: 0.9 }, "Page 9, item 1"),
    ],
  },
  {
    id: "doc-mekong-scan", name: "Mekong_delivery_note_scan.jpg", supplier_id: "S1", type: "notice",
    received_at: "2026-10-13T18:02", state: "failed", origin: "fixture", method: "simulated", size: 3_801_088,
    error: "No readable text found: the scan is too blurred. Ask the supplier for a PDF or enter the values by hand.",
    lines: [],
  },
];

/** Documents already processed start in review with their extracted lines. */
export const INBOX_FIXTURES: import("./types.js").InboxDoc[] = FIXTURE_DOCS.map((d) =>
  d.state === "needs_review" ? { ...d, lines: (d.fixtureLines || []).map((l) => ({ ...l })) } : d);

export const DOC_TYPE_LABEL = {
  price_list: "Price list", invoice: "Invoice", catalog: "Catalog", notice: "Delivery notice", email: "Supplier email", other: "Document",
};
