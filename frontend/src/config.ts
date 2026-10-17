/** Navigation is data. A page is added by listing it here and registering its mount function in
main.js; the shell, router and sidebar need no changes. */
export interface NavItem {
  id: string;
  label: string;
  icon: import("./lib/icons.js").IconName;
  group: "Workspace" | "Procurement" | "System";
  ready: boolean;
  /** one line for the placeholder and search */
  summary: string;
}

export const NAV: NavItem[] = [
  { id: "overview", label: "Overview", icon: "overview", group: "Workspace", ready: true,
    summary: "Inventory command center: what needs a decision today." },
  { id: "inventory", label: "Inventory", icon: "package", group: "Workspace", ready: true,
    summary: "Every SKU with stock, open orders, expiry and cover." },
  { id: "forecasts", label: "Demand Forecasts", icon: "trend", group: "Workspace", ready: true,
    summary: "Per-SKU forecasts, model choice and accuracy against baselines." },
  { id: "risk", label: "Risk Radar", icon: "radar", group: "Workspace", ready: true,
    summary: "Stockout, expiry, excess and slow-moving risk across the catalogue." },
  { id: "inbox", label: "Supplier Inbox", icon: "inbox", group: "Procurement", ready: true,
    summary: "Supplier PDFs and emails read by the AI extractor, waiting for confirmation." },
  { id: "cart", label: "Purchasing Cart", icon: "cart", group: "Procurement", ready: true,
    summary: "Recommended order lines grouped by supplier, ready to adjust and submit." },
  { id: "orders", label: "Purchase Orders", icon: "file", group: "Procurement", ready: true,
    summary: "Drafts waiting for approval, approved and rejected orders." },
  { id: "settings", label: "Settings & Integrations", icon: "settings", group: "System", ready: true,
    summary: "Budget, service level, data sources and model endpoint." },
];

export const DEFAULT_ROUTE = "overview";

/** Mirrors the breakpoints documented in css/tokens.css. */
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1180, xl: 1440 };
