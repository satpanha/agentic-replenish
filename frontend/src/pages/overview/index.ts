/** Overview page: composes the briefing, table, chart, insights and activity. */
import { $, html, setHTML } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { load, store } from "../../state.js";
import { briefing, briefingSkeleton } from "./briefing.js";
import { mountPriorityTable } from "./priority-table.js";
import { chartSkeleton, mountForecastChart } from "./forecast-chart.js";
import { activityPanel, insightsPanel } from "./feed.js";
import { pendingUpdates } from "../../data/model.js";
import { int, money } from "../../lib/format.js";
import { countUp, enterBlock, highlight, meter, settle } from "../../lib/motion.js";

/** KPIs count up once per session; after that they only settle when a value really changes. */
let countedOnce = false;
const FMT = { int, money };

/** @returns unmount */
export function mountOverview(root: HTMLElement): () => void {
  document.title = "Overview · StockPulse AMD";
  let cleanups: (() => void)[] = [];
  let prevMetrics: string[] | null = null;
  let prevMeter = 0;
  let prevInsights: Set<string> | null = null;

  /** Render the briefing, then point at what changed. */
  const paintBriefing = (s: import("../../state.js").AppState) => {
    const b = $("[data-briefing]", root);
    if (!b) return;
    setHTML(b, briefing(s));
    const vals = [...b.querySelectorAll(".mv")];
    if (!countedOnce) {
      countedOnce = true;
      vals.forEach((el) => countUp((el as HTMLElement), Number((el as HTMLElement).dataset.count), FMT[((el as HTMLElement).dataset.fmt as "int" | "money")]));
    } else if (prevMetrics) {
      settle(vals.filter((el, i) => el.textContent !== prevMetrics?.[i]));
    }
    const bar = (b.querySelector("[data-meter]") as HTMLElement | null);
    if (bar && prevMetrics) meter(bar, prevMeter);
    prevMetrics = vals.map((el) => (el.textContent as string));
    prevMeter = bar ? parseFloat(bar.style.width) : 0;
  };
  let mountedFor = (null as object | null);

  const render = () => {
    const s = store.get();
    if (s.status === "loading" && !s.data) {
      setHTML(root, html`<div class="ov" aria-busy="true">
        <div class="ov-briefing">${briefingSkeleton()}</div>
        <section class="panel ov-table">${chartSkeleton()}</section>
        <section class="panel ov-chart">${chartSkeleton()}</section>
        <section class="panel ov-insights">${chartSkeleton()}</section>
      </div>`);
      return;
    }
    if (s.status === "error" && !s.data) {
      setHTML(root, html`<div class="panel"><div class="state" role="alert">
        ${icon("alert")}<strong>The inventory engine didn't respond</strong>
        <span>${s.error}. Start it with <code class="mono">uvicorn app.main:app</code>, then try again.</span>
        <button class="btn btn-primary" type="button" data-retry>${icon("refresh", "icon-sm")}Try again</button>
      </div></div>`);
      $("[data-retry]", root)?.addEventListener("click", () => load());
      return;
    }
    if (mountedFor === s.data) return;
    cleanups.forEach((f) => f());
    mountedFor = s.data;
    setHTML(root, html`<div class="ov">
      <div class="ov-briefing" data-briefing></div>
      <section class="panel ov-table" data-table aria-labelledby="pt-title"></section>
      <div class="ov-stack">
        <section class="panel ov-chart" id="forecast" data-chart aria-labelledby="fc-title"></section>
        <section class="panel ov-activity" data-activity aria-labelledby="act-title"></section>
      </div>
      <section class="panel ov-insights" data-insights aria-labelledby="ins-title"></section>
    </div>`);
    paintBriefing(s);
    paintFeeds(s);
    cleanups = [
      mountPriorityTable((($("[data-table]", root)) as HTMLElement)),
      mountForecastChart((($("[data-chart]", root)) as HTMLElement)),
    ];
  };

  const paintFeeds = (s: import("../../state.js").AppState) => {
    const d = (s.data as import("../../data/types.js").Dashboard);
    const i = $("[data-insights]", root), a = $("[data-activity]", root);
    if (i) {
      setHTML(i, insightsPanel(d, pendingUpdates(s.docs)));
      const items = [...i.querySelectorAll(".insight[data-id]")];
      const fresh = prevInsights ? items.filter((el) => !prevInsights?.has(((el as HTMLElement).dataset.id as string))) : [];
      if (fresh.length) {
        enterBlock(fresh);
        fresh.forEach((el) => highlight(el, el.classList.contains("sev-critical") ? "red" : "amber"));
      }
      prevInsights = new Set(items.map((el) => ((el as HTMLElement).dataset.id as string)));
    }
    if (a) setHTML(a, activityPanel(d, s.docs, s.settings.budget));
  };

  render();
  const unsub = store.subscribe((s, ch) => {
    if (ch.has("data") || ch.has("status")) { render(); return; } // render() already paints briefing and feeds
    if (ch.has("docs") && s.data) paintFeeds(s);
    if ((ch.has("settings") || ch.has("period") || ch.has("fetchedAt") || ch.has("error") || ch.has("refreshing")) && s.data) paintBriefing(s);
  });
  return () => { unsub(); cleanups.forEach((f) => f()); };
}

/** Briefing period buttons live inside re-rendered markup, so they are handled by delegation. */
document.addEventListener("click", (e) => {
  const b = ((e.target as Element).closest("[data-period]") as HTMLElement | null);
  if (b) store.set({ period: (Number(b.dataset.period) as import("../../data/types.js").Period) });
});
document.addEventListener("keydown", (e) => {
  const b = (((e.target as Element).closest?.("[data-period]")) as HTMLElement | null);
  if (!b || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
  const opts = [7, 14, 28];
  const i = opts.indexOf(Number(b.dataset.period));
  const n = opts[(i + (e.key === "ArrowRight" ? 1 : -1) + opts.length) % opts.length];
  store.set({ period: (n as import("../../data/types.js").Period) });
  (document.querySelector(`[data-period="${n}"]`) as HTMLElement | null)?.focus();
  e.preventDefault();
});
