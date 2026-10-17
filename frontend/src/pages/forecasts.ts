/** Demand Forecasts: SKU-level forecast, interval, SMA-14 baseline, holdout accuracy and drivers. */
import { $, html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { METHOD_LABEL, addDays, int, one, parseDay, pct, plural } from "../lib/format.js";
import { fetchForecast } from "../data/api.js";
import { statusOf } from "../data/model.js";
import { addToCart, go, openAssistant, store } from "../state.js";
import { prov, statusBadge } from "../ui/status.js";
import { chartFrame, legend, mountChart } from "../ui/chart.js";
import { emptyState, pageHead } from "../ui/kit.js";
import { toast } from "../ui/overlay.js";
import { settle } from "../lib/motion.js";

const HORIZONS = [7, 14, 28];
const HISTORY = [28, 56, 90, 180];

export function mountForecasts(root: HTMLElement) {
  document.title = "Demand Forecasts · StockPulse AMD";
  const s0 = store.get();
  const st = { sku: s0.routeParams.sku || s0.chartSku || "", horizon: (s0.period as number), history: 56 };
  let fd: import("../data/types.js").ForecastDetail | null = null;
  let err = "", loading = false;
  let shownKey = ""; // which sku/horizon/history is on screen, so only real changes are animated
  let charts: ReturnType<typeof mountChart>[] = [];

  async function fetchIt() {
    const d = store.get().data;
    if (!d) return;
    if (!st.sku) st.sku = [...d.products].sort((a, b) => statusOf(a).rank - statusOf(b).rank || b.margin_at_risk - a.margin_at_risk)[0].sku;
    loading = true;
    paintBody();
    try { fd = await fetchForecast(st.sku, st.history, st.horizon); err = ""; }
    catch (e) { err = e instanceof Error ? e.message : String(e); fd = null; }
    loading = false;
    paintBody();
  }

  function frame() {
    const d = store.get().data;
    if (!d) { setHTML(root, html`<div class="panel">${emptyState({ title: "Loading forecasts…", iconName: "refresh" })}</div>`); return; }
    const cats = [...new Set(d.products.map((p) => p.category))].sort();
    setHTML(root, html`
      ${pageHead({ title: "Demand Forecasts", sub: "SKU-level forecasts from deterministic statistical models, scored against a 14-day moving average on the same holdout. No language model produces these numbers.",
        actions: html`<span data-fc-actions></span>` })}
      <div class="fc-controls panel">
        <div class="field grow"><label for="fc-pick">Product</label>
          <select class="select" id="fc-pick" data-key="fc-pick">${cats.map((c) => html`<optgroup label="${c}">${d.products.filter((p) => p.category === c).sort((a, b) => a.name.localeCompare(b.name)).map((p) => html`<option value="${p.sku}" ${p.sku === st.sku ? "selected" : ""}>${p.name} · ${p.sku}</option>`)}</optgroup>`)}</select></div>
        <div class="field"><span class="field-label" id="hz-l">Forecast horizon</span>
          <div class="segmented" role="radiogroup" aria-labelledby="hz-l">${HORIZONS.map((h) => html`<button type="button" role="radio" aria-checked="${st.horizon === h}" data-hz="${h}">${h} days</button>`)}</div></div>
        <div class="field"><span class="field-label" id="hs-l">History shown</span>
          <div class="segmented" role="radiogroup" aria-labelledby="hs-l">${HISTORY.map((h) => html`<button type="button" role="radio" aria-checked="${st.history === h}" data-hs="${h}">${h} days</button>`)}</div></div>
      </div>
      <div class="fc-grid">
        <div class="fc-main">
          <section class="panel" aria-labelledby="fcw-title">
            <div class="panel-head"><div><h2 class="panel-title" id="fcw-title" data-fc-title>Forecast</h2><p class="panel-sub" data-fc-sub></p></div><span data-fc-status></span></div>
            <div class="chart-stats" data-fc-stats></div>
            ${legend([{ label: "Actual sales", cls: "swatch-hist" }, { label: "Forecast", cls: "swatch-fc" }, { label: "80% interval", cls: "swatch-band" }, { label: "14-day SMA baseline", cls: "swatch-sma" }])}
            ${chartFrame("main")}
          </section>
          <section class="panel" aria-labelledby="ev-title">
            <div class="panel-head"><div><h2 class="panel-title" id="ev-title">Forecast evaluation</h2><p class="panel-sub" data-ev-sub></p></div>${prov("calc")}</div>
            ${legend([{ label: "Actual", cls: "swatch-hist" }, { label: "Model (fitted without these days)", cls: "swatch-fc" }, { label: "SMA-14", cls: "swatch-sma" }])}
            ${chartFrame("eval")}
            <div data-ev-table></div>
          </section>
        </div>
        <aside class="fc-side" data-fc-side></aside>
      </div>`);
    charts.forEach((c) => c.destroy());
    charts = [mountChart(root, "main"), mountChart(root, "eval")];
  }

  function paintBody() {
    const s = store.get();
    const d = s.data;
    if (!d || !$("[data-fc-stats]", root)) return;
    const p = d.products.find((x) => x.sku === st.sku);
    const busy = loading ? "is-loading" : "";
    root.querySelectorAll(".fc-main .panel, .fc-side").forEach((el) => el.classList.toggle("is-loading", !!busy));
    if (err) {
      setHTML((($("[data-fc-stats]", root)) as HTMLElement), html`<div class="callout callout-critical" style="grid-column:1/-1">${err}</div>`);
      return;
    }
    if (!fd || !p) return;
    const f = fd;
    const today = parseDay(f.as_of);
    const h = f.history.length, n = f.forecast.length;
    const total = f.forecast.reduce((a, b) => a + b.value, 0);
    const mm = f.holdout.metrics.model, ms = f.holdout.metrics.sma14;
    const better = mm.wape < ms.wape;
    const key = `${f.sku}|${n}|${h}`;
    const changed = key !== shownKey;
    const settleAfter = changed && !!shownKey; // not on first paint: the page entrance covers that
    shownKey = key;

    setHTML((($("[data-fc-title]", root)) as HTMLElement), html`${f.name}`);
    setHTML((($("[data-fc-sub]", root)) as HTMLElement), html`<span class="mono">${f.sku}</span> · ${f.supplier_name} · units per day, last ${h} days and the next ${n}`);
    setHTML((($("[data-fc-status]", root)) as HTMLElement), statusBadge(statusOf(p)));
    setHTML((($("[data-fc-actions]", root)) as HTMLElement), html`
      <button class="btn btn-secondary" type="button" data-go-risk>${icon("radar", "icon-sm")}Inspect inventory risk</button>
      ${s.cart[p.sku] ? html`<a class="btn btn-primary" href="#/cart?sku=${p.sku}">${icon("cart", "icon-sm")}Open in Purchasing Cart</a>`
        : html`<button class="btn btn-primary" type="button" data-add="${p.sku}">${icon("plus", "icon-sm")}${p.recommendation ? `Add ${int(p.recommendation.qty)} to cart` : "Add to cart"}</button>`}`);
    setHTML((($("[data-fc-stats]", root)) as HTMLElement), html`
      <div class="chart-stat">Forecast, next ${n} days<b class="num">${int(total)} units</b></div>
      <div class="chart-stat">80% range (approx.)<b class="num">${int(f.factors.interval_total[0])}–${int(f.factors.interval_total[1])}</b></div>
      <div class="chart-stat">SMA-14 would say<b class="num">${int(f.sma14 * n)} units</b></div>
      <div class="chart-stat">Model<b style="font-size:var(--fs-sm)">${METHOD_LABEL[f.model.method] || f.model.method}</b></div>`);

    const pad = (a: (number|null)[], b = 0, c = 0) => [...Array(b).fill(null), ...a, ...Array(c).fill(null)];
    charts[0].draw({
      dates: [...f.history.map((_, i) => addDays(today, i - h)), ...f.forecast.map((_, i) => addDays(today, i))],
      series: [
        { label: "SMA-14", values: pad(Array(14 + n).fill(f.sma14), h - 14), cls: "sma", color: "var(--amber)" },
        { label: "Actual", values: pad(f.history, 0, n), cls: "hist", color: "var(--ink-2)" },
        { label: "Forecast", values: [...Array(h - 1).fill(null), f.history[h - 1], ...f.forecast.map((x) => x.value)], cls: "fc", color: "var(--blue)" },
      ],
      band: { lo: pad(f.forecast.map((x) => x.lo), h), hi: pad(f.forecast.map((x) => x.hi), h), label: "80% interval" },
      marker: { index: h, label: "Today" },
      shade: { from: h, to: h + f.factors.lead_time_days, label: `Lead time ${int(f.factors.lead_time_days)}d` },
      height: 320,
      desc: `${f.name}: ${int(total)} units forecast over ${n} days, 80% range ${int(f.factors.interval_total[0])} to ${int(f.factors.interval_total[1])}; SMA-14 would predict ${int(f.sma14 * n)}.`,
    }, { reveal: changed });
    const hs = parseDay(f.holdout.start);
    charts[1].draw({
      dates: f.holdout.actual.map((_, i) => addDays(hs, i)),
      series: [
        { label: "SMA-14", values: f.holdout.sma14, cls: "sma", color: "var(--amber)" },
        { label: "Actual", values: f.holdout.actual, cls: "hist", color: "var(--ink-2)" },
        { label: "Model", values: f.holdout.model, cls: "fc", color: "var(--blue)" },
      ],
      height: 200,
      desc: `Holdout of ${f.holdout.days} days: model WAPE ${pct(mm.wape)}, SMA-14 WAPE ${pct(ms.wape)}.`,
    });
    setHTML((($("[data-ev-sub]", root)) as HTMLElement), html`Last ${f.holdout.days} days held out: both methods forecast them using only earlier data. ${better ? html`The model beats the baseline by <b>${one((ms.wape - mm.wape) * 100)} pts</b> of WAPE.` : html`The baseline is as good or better on this SKU.`}`);
    const row = (label: string, a: number | null, b: number | null, fmt: (v: number) => string, hint: string, lowerBetter = true) => html`<tr><th scope="row">${label}<span class="cell-sub">${hint}</span></th>
      <td class="r num ${a != null && b != null && (lowerBetter ? a < b : Math.abs(a) < Math.abs(b)) ? "is-better" : ""}">${a == null ? html`<span class="muted">n/a</span>` : fmt(a)}</td>
      <td class="r num">${b == null ? html`<span class="muted">n/a</span>` : fmt(b)}</td></tr>`;
    setHTML((($("[data-ev-table]", root)) as HTMLElement), html`<div class="table-wrap"><table class="ptable metrics-table">
      <thead><tr><th scope="col">Metric</th><th scope="col" class="r">Model</th><th scope="col" class="r">SMA-14</th></tr></thead>
      <tbody>
        ${row("WAPE", mm.wape, ms.wape, (v) => pct(v), "total absolute error ÷ total demand")}
        ${row("MAE", mm.mae, ms.mae, (v) => `${one(v)} units`, "average daily miss")}
        ${row("RMSE", mm.rmse, ms.rmse, (v) => `${one(v)} units`, "penalises big misses")}
        ${row("MAPE", mm.mape, ms.mape, (v) => pct(v), "average % miss on non-zero days")}
        ${row("Bias", mm.bias, ms.bias, (v) => `${v > 0 ? "+" : ""}${one(v)} units`, "positive = over-forecasting", false)}
      </tbody></table></div>
      <p class="table-note">${mm.mape_note || ms.mape_note ? html`${icon("info", "icon-xs")} ${mm.mape_note || ms.mape_note} ` : ""}Calculated by the engine on ${d.is_sample_data ? "the sample dataset" : "imported data"} (${plural(mm.n, "day")}); not a live forecasting service.</p>`);

    const fa = f.factors;
    const wf = [...fa.weekday_factors].sort((a, b) => b.factor - a.factor);
    const spread = wf[0].factor - wf[wf.length - 1].factor;
    const trend = fa.trend_pct;
    setHTML((($("[data-fc-side]", root)) as HTMLElement), html`
      <section class="panel" aria-labelledby="why-title">
        <div class="panel-head"><div><h2 class="panel-title" id="why-title">What drives this forecast</h2><p class="panel-sub">Written from the numbers on this page, by rules, not a language model.</p></div></div>
        <ul class="drivers">
          <li><b>Recent velocity</b><p>${one(fa.velocity_7d)} a day over the last week, ${one(fa.velocity_28d)} over 28 days${trend != null ? html`, <span class="${trend > 0.05 ? "txt-up" : trend < -0.05 ? "txt-down" : ""}">${trend > 0 ? "+" : ""}${pct(trend, 0)}</span> on the 28 days before` : ""}.</p></li>
          <li><b>Weekly pattern</b><p>${spread > 0.15 ? html`${wf[0].day} sells ${pct(wf[0].factor - 1, 0)} above an average day, ${wf[wf.length - 1].day} ${pct(1 - wf[wf.length - 1].factor, 0)} below.` : "Little difference between weekdays."}</p>
            <div class="weekdays" aria-hidden="true">${fa.weekday_factors.map((w: {day: string, factor: number}) => html`<span style="--h:${Math.max(8, Math.min(100, 50 + (w.factor - 1) * 150))}%"><i></i>${w.day[0]}</span>`)}</div></li>
          <li><b>Promotions</b><p>Not recorded in this dataset. ${fa.max_day_56d > fa.velocity_28d * 2.5 ? `The highest day in 56 was ${int(fa.max_day_56d)} units, about ${one(fa.max_day_56d / Math.max(fa.velocity_28d, 0.1))}× normal, which may be a promotion the data doesn't label.` : "No unusual spikes in the last 56 days."}</p></li>
          <li><b>Variability</b><p>Daily sales vary by ${fa.cv_56d == null ? "n/a" : pct(fa.cv_56d, 0)} of their average${fa.zero_days_56d ? `, with ${plural(fa.zero_days_56d, "zero-sales day")}` : ""}. Model residual σ ${one(f.model.sigma_daily)} units a day.</p></li>
          <li><b>Supplier lead time</b><p>${int(fa.lead_time_days)} ± ${one(fa.lead_time_std_days)} days, so about ${int(f.forecast.slice(0, Math.ceil(fa.lead_time_days)).reduce((a, b) => a + b.value, 0))} units sell before a new order can arrive.</p></li>
          <li><b>Confidence</b><p>80% of days should land inside the shaded band. The horizon total range assumes independent daily errors, so treat it as approximate.</p></li>
        </ul>
        <div class="panel-foot"><button class="btn btn-secondary btn-sm" type="button" data-ask>${icon("scan", "icon-xs")}Ask why it's at risk</button></div>
      </section>
      <section class="panel" aria-labelledby="cand-title">
        <div class="panel-head"><div><h2 class="panel-title" id="cand-title">Models compared</h2><p class="panel-sub">Lowest holdout WAPE wins.</p></div></div>
        <table class="ptable cand-table"><tbody>${Object.entries(f.model.candidates).sort((a, b) => a[1] - b[1]).map(([m, w]) => html`<tr style="cursor:default" class="${m === f.model.method ? "is-selected" : ""}">
          <td>${METHOD_LABEL[m] || m}${m === f.model.method ? html` <span class="status status-info">Selected</span>` : ""}</td><td class="r num">${pct(w)}</td></tr>`)}
          <tr style="cursor:default"><td class="muted">14-day SMA (baseline)</td><td class="r num muted">${pct(ms.wape)}</td></tr></tbody></table>
      </section>`);
    if (settleAfter) settle([...root.querySelectorAll("[data-fc-stats] .chart-stat, [data-ev-table] tbody, [data-fc-side] .panel")]);
  }

  on(root, "change", "#fc-pick", (_e, t) => { st.sku = (t as HTMLSelectElement).value; store.set({ chartSku: st.sku }); history.replaceState(null, "", `#/forecasts?sku=${st.sku}`); fetchIt(); });
  // the horizon is the app-wide period, so the Overview, tables and product drawer show the same window
  on(root, "click", "[data-hz]", (_e, t) => { st.horizon = Number(t.dataset.hz); store.set({ period: st.horizon as import("../data/types.js").Period }); frameAndFetch(); });
  on(root, "click", "[data-hs]", (_e, t) => { st.history = Number(t.dataset.hs); frameAndFetch(); });
  on(root, "click", "[data-go-risk]", () => go(`risk?sku=${st.sku}`));
  on(root, "click", "[data-add]", (_e, t) => { addToCart([(t.dataset.add as string)]); toast("Added to the Purchasing Cart", { label: "Review cart", run: () => go(`cart?sku=${st.sku}`) }); paintBody(); });
  on(root, "click", "[data-ask]", () => openAssistant(st.sku, "Why is this SKU at risk?"));
  const frameAndFetch = () => { frame(); fetchIt(); };

  frameAndFetch();
  const unsub = store.subscribe((_s, ch) => { if (ch.has("data")) frameAndFetch(); else if (ch.has("cart")) paintBody(); });
  return () => { unsub(); charts.forEach((c) => c.destroy()); };
}
