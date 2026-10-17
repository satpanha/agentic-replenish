import { html } from "../lib/dom.js";
import { icon } from "../lib/icons.js";

const LEVEL_ICON: Record<string, import("../lib/icons.js").IconName> = { critical: "octagon", warning: "alert", excess: "archive", healthy: "checkCircle", info: "info" };

/** Status badge: icon + words + tint. Colour is never the only signal. */
export const statusBadge = (s: import("../data/types.js").Status) =>
  html`<span class="status status-${s.level}">${icon(LEVEL_ICON[s.level])}${s.label}</span>`;

export const severityIcon = (sev: "critical" | "warning" | "info") => icon(LEVEL_ICON[sev]);

/** Where a number came from. */
export const prov = (kind: "calc" | "ai" | "sample") =>
  html`<span class="prov prov-${kind}">${kind === "calc" ? "Calculated" : kind === "ai" ? "AI-extracted" : "Sample"}</span>`;
