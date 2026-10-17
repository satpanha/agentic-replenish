/** A + B: page introduction and the four operational metrics. */
import { html } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { addDays, int, list, money, parseDay, plural, shortDate } from "../../lib/format.js";
import { metrics, summary } from "../../data/model.js";
import { WORKSPACE } from "../../data/demo.js";
import { prov } from "../../ui/status.js";

const PERIODS = (([7, 14, 28]) as const);

export function briefing(s: import("../../state.js").AppState) {
  const d = (s.data as import("../../data/types.js").Dashboard);
  const sm = summary(d);
  const m = metrics(d, s.period, s.settings.budget);
  const through = shortDate(addDays(parseDay(d.as_of), -1));
  const pctUsed = Math.round(m.spend.utilisation * 100);

  const sentence = sm.decisions
    ? html`${sm.stable} of ${sm.total} products are stable, but <b>${plural(sm.decisions, "purchasing decision")} need attention</b>: ${sm.critical ? html`${plural(sm.critical, "product")} will run out before a new delivery can arrive` : ""}${sm.critical && sm.reorder ? " and " : ""}${sm.reorder ? html`${int(sm.reorder)} more should be reordered this cycle` : ""}.`
    : html`All ${sm.total} products are covered through their supplier lead times. No purchasing decisions are due.`;

  return html`
  <section class="briefing" aria-labelledby="page-title">
    <div class="briefing-top">
      <div>
        <h1 id="page-title">Inventory Command Center</h1>
        <p class="briefing-summary">${sentence}</p>
        <div class="briefing-meta">
          <span>${icon("store", "icon-xs")}${WORKSPACE.name}</span>
          <span>${icon("clock", "icon-xs")}Sales through ${through} · engine run ${s.fetchedAt ? s.fetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "-"}</span>
          <span><span class="dot ${s.error ? "" : "dot-live"}" style="${s.error ? "background:var(--red)" : ""}"></span>${s.error ? "Engine unreachable, showing last result" : "Engine online"}</span>
          ${d.is_sample_data ? html`<span class="tag-demo" title="Numbers are calculated by the real engine on the bundled sample dataset, not live store data.">Sample dataset</span>` : ""}
        </div>
      </div>
      <div class="briefing-controls">
        <span id="period-label" class="visually-hidden">Reporting period</span>
        <div class="segmented" role="radiogroup" aria-labelledby="period-label">
          ${PERIODS.map((p) => html`<button type="button" role="radio" aria-checked="${s.period === p}" data-period="${p}">Next ${p} days</button>`)}
        </div>
        <span class="muted" style="font-size:var(--fs-xs)">${shortDate(parseDay(d.as_of))} – ${shortDate(addDays(parseDay(d.as_of), s.period - 1))}</span>
      </div>
    </div>

    <div class="metrics" role="list">
      <div class="metric ${m.atRisk.count ? "is-critical" : ""}" role="listitem">
        <div class="metric-label"><span>SKUs at stockout risk</span>${prov("calc")}</div>
        <div class="metric-value num"><span class="mv" data-count="${m.atRisk.count}" data-fmt="int">${int(m.atRisk.count)}</span>
          ${m.atRisk.soon ? html`<span class="metric-delta up-bad" title="${list(m.atRisk.soonNames)}">${icon("arrowUp", "icon-xs")}${int(m.atRisk.soon)} by ${shortDate(m.atRisk.by)}</span>` : html`<span class="metric-delta flat">No change by ${shortDate(m.atRisk.by)}</span>`}
        </div>
        <p class="metric-context">Will run out before a delivery ordered today arrives. ${m.atRisk.soon ? html`<strong>${int(m.atRisk.soon)} more</strong> cross ${m.atRisk.soon === 1 ? "its" : "their"} lead time within ${s.period} days if nothing is ordered.` : ""}</p>
      </div>
      <div class="metric" role="listitem">
        <div class="metric-label"><span>Margin at risk</span>${prov("calc")}</div>
        <div class="metric-value num"><span class="mv" data-count="${m.margin.value}" data-fmt="money">${money(m.margin.value)}</span></div>
        <p class="metric-context">Gross margin on about <strong>${int(m.margin.units)} units</strong> of forecast demand that stock and open orders can't cover before the next delivery.</p>
      </div>
      <div class="metric" role="listitem">
        <div class="metric-label"><span>Dead-stock capital</span>${prov("calc")}</div>
        <div class="metric-value num"><span class="mv" data-count="${m.dead.value}" data-fmt="money">${money(m.dead.value)}</span></div>
        <p class="metric-context">Cost value of stock beyond <strong>${int(m.dead.threshold)} days</strong> of cover, across ${plural(m.dead.count, "SKU")}.</p>
      </div>
      <div class="metric" role="listitem">
        <div class="metric-label"><span>Recommended purchasing spend</span>${prov("calc")}</div>
        <div class="metric-value num"><span class="mv" data-count="${m.spend.value}" data-fmt="money">${money(m.spend.value)}</span> <small>of ${money(m.spend.budget)}</small></div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pctUsed}" aria-label="Budget used"><i data-meter style="width:${Math.min(100, pctUsed)}%;background:${pctUsed > 100 ? "var(--red)" : pctUsed > 85 ? "var(--amber)" : "var(--indigo)"}"></i></div>
        <p class="metric-context"><strong>${pctUsed}%</strong> of the weekly budget · ${money(Math.max(0, m.spend.budget - m.spend.value))} left · ${plural(m.spend.lines, "line")}, ${plural(m.spend.suppliers, "supplier")}</p>
      </div>
    </div>
  </section>`;
}

export function briefingSkeleton() {
  return html`<section class="briefing" aria-busy="true" aria-label="Loading briefing">
    <div class="briefing-top"><div style="display:grid;gap:12px">
      <div class="skeleton" style="width:280px;height:24px"></div>
      <div class="skeleton sk-line" style="width:min(560px,90%)"></div>
      <div class="skeleton sk-line" style="width:min(360px,70%)"></div></div></div>
    <div class="metrics">${[0, 1, 2, 3].map(() => html`<div class="metric"><div class="skeleton sk-line" style="width:60%"></div><div class="skeleton" style="width:40%;height:26px"></div><div class="skeleton sk-line" style="width:85%"></div></div>`)}</div>
  </section>`;
}
