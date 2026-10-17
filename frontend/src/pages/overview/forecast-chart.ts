/** D: demand forecast chart on the Overview. Drawn by the shared chart engine. */
import { $, html, setHTML } from "../../lib/dom.js";
import { METHOD_LABEL, int, pct } from "../../lib/format.js";
import { chartSeries, statusOf } from "../../data/model.js";
import { store } from "../../state.js";
import { prov } from "../../ui/status.js";
import { chartFrame, legend, mountChart } from "../../ui/chart.js";

export function mountForecastChart(el: HTMLElement) {
  const d0 = (store.get().data as import("../../data/types.js").Dashboard);
  const options = [...d0.products].sort((a, b) => statusOf(a).rank - statusOf(b).rank || a.name.localeCompare(b.name));
  setHTML(el, html`
    <div class="panel-head">
      <div>
        <h2 class="panel-title" id="fc-title">Demand forecast</h2>
        <p class="panel-sub" data-fc-sub></p>
      </div>
      <div class="chart-head-controls">
        <label class="visually-hidden" for="fc-sku">Product</label>
        <select class="select" id="fc-sku" data-fc-sku>
          ${options.map((p) => html`<option value="${p.sku}">${p.name} (${p.sku})</option>`)}
        </select>
      </div>
    </div>
    <div class="chart-stats" data-fc-stats></div>
    ${legend([{ label: "Actual sales", cls: "swatch-hist" }, { label: "Forecast", cls: "swatch-fc" }, { label: "80% interval", cls: "swatch-band" }, { label: "14-day SMA baseline", cls: "swatch-sma" }])}
    ${chartFrame("ov")}
    <div class="chart-foot" data-fc-foot></div>`);

  const sel = (($("[data-fc-sku]", el)) as HTMLSelectElement);
  sel.addEventListener("change", () => store.set({ chartSku: sel.value }));
  const chart = mountChart(el, "ov");
  paint(el, store.get(), chart, true);
  const unsub = store.subscribe((s, ch) => {
    // reveal only when the chart shows different data; a background refresh redraws in place
    if (ch.has("chartSku") || ch.has("period") || ch.has("data")) paint(el, s, chart, ch.has("chartSku") || ch.has("period"));
  });
  return () => { chart.destroy(); unsub(); };
}

/** Pick the default product: the most urgent stockout. */
export function defaultChartSku(d: import("../../data/types.js").Dashboard) {
  return [...d.products].sort((a, b) => statusOf(a).rank - statusOf(b).rank || b.margin_at_risk - a.margin_at_risk)[0].sku;
}

function paint(el: HTMLElement, s: import("../../state.js").AppState, chart: ReturnType<typeof mountChart>, reveal: boolean = false) {
  const d = (s.data as import("../../data/types.js").Dashboard);
  const sku = s.chartSku || defaultChartSku(d);
  const p = d.products.find((x) => x.sku === sku) || d.products[0];
  (($("[data-fc-sku]", el)) as HTMLSelectElement).value = p.sku;
  const c = chartSeries(d, p, s.period);
  const f = p.forecast;
  const better = f.sma14_wape != null && f.wape < f.sma14_wape;

  setHTML((($("[data-fc-sub]", el)) as HTMLElement), html`Units per day · last ${c.history.length} days and the next ${s.period}`);
  setHTML((($("[data-fc-stats]", el)) as HTMLElement), html`
    <div class="chart-stat">Forecast, next ${s.period} days<b class="num">${int(c.total)} units</b></div>
    <div class="chart-stat">14-day SMA would say<b class="num">${int(c.smaTotal)} units</b></div>
    <div class="chart-stat">Model error (WAPE)<b class="num ${better ? "better" : ""}">${pct(f.wape)}</b></div>
    <div class="chart-stat">SMA-14 error (WAPE)<b class="num">${f.sma14_wape == null ? "n/a" : pct(f.sma14_wape)}</b></div>`);
  setHTML((($("[data-fc-foot]", el)) as HTMLElement), html`
    <span>${prov("calc")} &nbsp;${METHOD_LABEL[f.method] || f.method}, chosen by lowest error on the last 28 days of history.</span>
    <a href="#/forecasts?sku=${p.sku}">Open in Demand Forecasts</a>`);

  const h = c.history.length;
  const nf = c.forecast.length;
  const pad = (a: (number | null)[], before = 0, after = 0) => [...Array(before).fill(null), ...a, ...Array(after).fill(null)];
  chart.draw({
    dates: [...c.history.map((x) => x.date), ...c.forecast.map((x) => x.date)],
    series: [
      { label: "SMA-14", values: pad(Array(14 + nf).fill(c.sma), h - 14), cls: "sma", color: "var(--amber)" },
      { label: "Actual", values: pad(c.history.map((x) => x.value), 0, nf), cls: "hist", color: "var(--ink-2)" },
      { label: "Forecast", values: [...Array(h - 1).fill(null), c.history[h - 1].value, ...c.forecast.map((x) => x.value)].slice(0, h + nf), cls: "fc", color: "var(--blue)" },
    ],
    band: { lo: pad(c.forecast.map((x) => x.lo), h), hi: pad(c.forecast.map((x) => x.hi), h), label: "80% interval" },
    marker: { index: h, label: "Today" },
    shade: { from: h, to: h + c.leadTime, label: `Lead time ${int(c.leadTime)}d` },
    height: 300,
    desc: `${p.name}: about ${int(p.daily_forecast)} units a day forecast; ${int(c.total)} units over the next ${s.period} days. The 14-day moving average would predict ${int(c.smaTotal)}.`,
  }, { reveal });
}

export function chartSkeleton() {
  return html`<div class="panel-head"><div style="display:grid;gap:8px"><div class="skeleton sk-line" style="width:160px"></div><div class="skeleton sk-line" style="width:240px"></div></div></div>
    <div class="panel-body"><div class="skeleton sk-block"></div></div>`;
}
