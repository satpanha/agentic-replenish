/**
 * Motion vocabulary for StockPulse, built on Anime.js v4 (vendored ESM bundle).
 *
 * Rules: motion explains a change, it never carries information on its own. Entrances only run when
 * a page or panel genuinely appears. Financial figures are never tweened through intermediate values
 * in the cart; they settle in place. Every helper runs inside an Anime.js scope whose `reduce` media
 * query follows the OS reduced-motion setting: with it on, movement and count-ups are dropped and
 * state changes keep only a short opacity or colour cue.
 *
 * Pages animate inside an Anime.js scope that main.js replaces on every route change; reverting it
 * stops and cleans everything the page started, so no animation outlives its DOM.
 */
import { animate, createScope, createDrawable, stagger, cleanInlineStyles, type JSAnimation } from "animejs";

const MQ = { reduce: "(prefers-reduced-motion: reduce)" };

/** Durations (ms) and easings, per the product's motion guidelines. */
export const T = { tap: 140, state: 200, enter: 280, sequence: 380, highlight: 900 };
const EASE_OUT = "outCubic";
const EASE_STATE = "inOutQuad";

export type Scope = import("animejs").Scope;

let page: Scope = createScope({ mediaQueries: MQ });

/** Run `fn` inside a scope so its animations are tracked and reverted with it. */
const within = <R>(s: Scope, fn: (reduce: boolean) => R): R => s.execute((sc) => fn(!!sc.matches.reduce));

const inPage = <R>(fn: (reduce: boolean) => R) => within(page, fn);
export const reducedMotion = () => matchMedia(MQ.reduce).matches;
/**
 * Surfaces that outlive pages (drawer, toasts, dialog, assistant) animate outside any scope:
 * their animations finish and are garbage-collected instead of piling up in a scope that is never
 * reverted. They still follow the same reduced-motion query.
 */
const inApp = <R>(fn: (reduce: boolean) => R) => fn(reducedMotion());

/** Called by the router: revert the previous page's animations and start a fresh scope. */
export function newPageScope(root: HTMLElement) {
  page.revert();
  page = createScope({ root, mediaQueries: MQ });
}

/** Leave no inline transform behind (it would change containing blocks for sticky/fixed content). */
const clean = { onComplete: (a: JSAnimation) => cleanInlineStyles(a) };

// ---- A. entrances -----------------------------------------------------------------------------

/**
 * Page entrance: the header first, then up to four main regions, short and staggered.
 * Content stays interactive throughout (opacity starts above zero, no pointer blocking).
 */
export function enterPage(root: HTMLElement) {
  inPage((reduce) => {
    if (reduce) return;
    const head = root.querySelector(":scope > .page-head, :scope > .ov > .ov-briefing, :scope > .back-link, :scope > .preview-bar");
    const regions = [...root.querySelectorAll(":scope > *, :scope > .ov > *")]
      .filter((el) => el !== head && !el.classList.contains("ov") && !el.classList.contains("back-link") && el.getBoundingClientRect().top < innerHeight + 40)
      .slice(0, 4);
    if (head) animate(head, { opacity: [0, 1], translateY: [6, 0], duration: T.state, ease: EASE_OUT, ...clean });
    if (regions.length) animate(regions, { opacity: [0.001, 1], translateY: [10, 0], duration: T.enter, delay: stagger(55, { start: 60 }), ease: EASE_OUT, ...clean });
  });
}

/** A panel or block that just appeared because state changed (review panel, new answer). */
export function enterBlock(els: Element | Element[] | NodeListOf<Element>, opts = ({} as {stagger?: number, max?: number})) {
  const list = (els instanceof Element ? [els] : [...els]).slice(0, opts.max ?? 8);
  if (!list.length) return;
  inPage((reduce) => {
    animate(list, reduce
      ? { opacity: [0.4, 1], duration: T.tap, ...clean }
      : { opacity: [0, 1], translateY: [8, 0], duration: T.enter, delay: stagger(opts.stagger ?? 40), ease: EASE_OUT, ...clean });
  });
}

// ---- B. interaction feedback ------------------------------------------------------------------

/**
 * Briefly tint a row or element to point at what just changed, then fade back.
 * Colour only, so it is safe with reduced motion and never moves layout.
 */
export function highlight(els: Element | Element[], tone: "indigo" | "amber" | "red" | "green" = "indigo") {
  const list = els instanceof Element ? [els] : els;
  if (!list.length) return;
  const from = { indigo: "rgba(79,103,232,.14)", amber: "rgba(217,154,34,.16)", red: "rgba(217,79,97,.14)", green: "rgba(40,152,121,.14)" }[tone];
  inPage(() => animate(list, { backgroundColor: [from, "rgba(255,255,255,0)"], duration: T.highlight, ease: "outQuad", ...clean }));
}

/** A figure that changed settles in place: no counting through wrong intermediate values. */
export function settle(els: Element | Element[]) {
  const list = els instanceof Element ? [els] : els;
  if (!list.length) return;
  inPage((reduce) => animate(list, reduce
    ? { opacity: [0.5, 1], duration: T.tap, ...clean }
    : { opacity: [0.35, 1], translateY: [3, 0], duration: T.state, ease: EASE_OUT, ...clean }));
}

/** Status chip that just changed state. */
export function confirmState(el: Element | null) {
  if (!el) return;
  inPage((reduce) => animate(el, reduce
    ? { opacity: [0.4, 1], duration: T.state, ...clean }
    : { scale: [0.92, 1], opacity: [0.5, 1], duration: T.state, ease: "out(2)", ...clean }));
}

/** Move a meter bar from its previous width to the current one. */
export function meter(bar: HTMLElement | null, fromPct: number) {
  if (!bar) return;
  const to = bar.style.width;
  if (!to || `${fromPct}%` === to) return;
  inPage((reduce) => { if (!reduce) animate(bar, { width: [`${fromPct}%`, to], duration: T.state + 60, ease: EASE_STATE }); });
}

/** Remove a row with a short fade before the state update re-renders. */
export function leave(els: Element[], done: () => void) {
  if (!els.length) return done();
  inPage((reduce) => {
    if (reduce) return done();
    animate(els, { opacity: [1, 0], translateX: [0, 8], duration: T.tap + 20, ease: "inQuad", onComplete: () => done() });
  });
}

// ---- C. state transitions with data -------------------------------------------------------------

/**
 * Count a KPI up once, on first load. The element's final text is set from the same formatter, so
 * the settled value is exactly the calculated one.
 */
export function countUp(el: HTMLElement, to: number, fmt: (n: number) => string) {
  inPage((reduce) => {
    if (reduce || !Number.isFinite(to) || to === 0) { el.textContent = fmt(to); return; }
    const v = { n: 0 };
    el.textContent = fmt(0); // start from zero in this frame so the final value never flashes first
    animate(v, { n: to, duration: T.sequence + 120, ease: "outQuart", onUpdate: () => { el.textContent = fmt(v.n); }, onComplete: () => { el.textContent = fmt(to); } });
  });
}

/**
 * Reveal a chart that shows new data (new SKU or horizon): the forecast line draws from today
 * forward and the interval fades in. History is not animated; it is old data.
 */
export function revealChart(svg: SVGSVGElement): JSAnimation[] | undefined {
  return inPage((reduce) => {
    const fc = svg.querySelectorAll("path.fc");
    const band = svg.querySelectorAll("path.band, path.sma");
    if (reduce) { animate([...fc, ...band], { opacity: [0.3, 1], duration: T.state }); return; }
    const anims: JSAnimation[] = [];
    if (fc.length) anims.push(animate(createDrawable(fc), { draw: ["0 0", "0 1"], duration: T.sequence + 140, ease: "inOutSine" }));
    if (band.length) anims.push(animate(band, { opacity: [0, 1], duration: T.sequence, delay: 120, ease: EASE_OUT }));
    return anims;
  });
}

// ---- app-level surfaces: drawer, toasts, dialog, assistant -------------------------------------

export function drawerIn(scrim: HTMLElement, panel: HTMLElement) {
  inApp((reduce) => {
    animate(scrim, { opacity: [0, 1], duration: T.state, ease: "linear" });
    animate(panel, reduce ? { opacity: [0, 1], duration: T.state } : { opacity: [0, 1], translateX: [28, 0], duration: T.enter, ease: EASE_OUT, ...clean });
  });
}

export function drawerOut(scrim: HTMLElement, panel: HTMLElement, done: () => void) {
  inApp((reduce) => {
    animate(scrim, { opacity: 0, duration: T.tap + 20, ease: "linear" });
    animate(panel, { opacity: 0, ...(reduce ? {} : { translateX: 20 }), duration: T.tap + 30, ease: "inQuad", onComplete: () => done() });
  });
}

export const toastIn = (el: HTMLElement) => inApp((reduce) => animate(el, reduce ? { opacity: [0, 1], duration: T.state } : { opacity: [0, 1], translateY: [10, 0], duration: T.state + 40, ease: EASE_OUT }));

export const toastOut = (el: HTMLElement, done: () => void) => inApp((reduce) => animate(el, { opacity: 0, ...(reduce ? {} : { translateY: 6 }), duration: T.state, ease: "inQuad", onComplete: () => done() }));

/** @param el dialog or floating panel opening */
export const surfaceIn = (el: HTMLElement) => inApp((reduce) => animate(el, reduce ? { opacity: [0, 1], duration: T.state } : { opacity: [0, 1], translateY: [8, 0], scale: [0.99, 1], duration: T.enter, ease: EASE_OUT, ...clean }));

/** New element inside an app-level surface (assistant answer). */
export const surfaceItemIn = (el: Element) => inApp((reduce) => animate(el, reduce ? { opacity: [0.4, 1], duration: T.tap } : { opacity: [0, 1], translateY: [6, 0], duration: T.state + 40, ease: EASE_OUT, ...clean }));
