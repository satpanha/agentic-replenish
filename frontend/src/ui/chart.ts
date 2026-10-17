/** Line chart engine (plain SVG, redrawn at its real width so text never scales). */
import { $, html, setHTML } from "../lib/dom.js";
import { dayDate, int, one, shortDate } from "../lib/format.js";
import { revealChart } from "../lib/motion.js";

export interface ChartSpec {
  dates: Date[];
  series: {label: string, values: (number | null)[], cls: string, color: string}[];
  band?: {lo: (number | null)[], hi: (number | null)[], label: string};
  /** vertical dashed line (e.g. today) */
  marker?: {index: number, label: string};
  /** shaded x-range (e.g. lead time) */
  shade?: {from: number, to: number, label: string};
  height?: number;
  /** accessible summary */
  desc: string;
}

const M = { top: 18, right: 12, bottom: 28, left: 42 };

function niceMax(max: number) {
  const step = Math.pow(10, Math.floor(Math.log10(max || 1)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= max) return m * step;
  return 10 * step;
}

export function drawChart(svg: SVGSVGElement, tip: HTMLElement, width: number, c: ChartSpec) {
  const H = c.height || 300;
  const W = Math.max(280, width);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;
  const n = c.dates.length;
  const vals = [...c.series.flatMap((s) => s.values), ...(c.band ? c.band.hi : [])].filter((v) => v != null);
  const yMax = niceMax(Math.max(1, ...(vals as number[])) * 1.05);
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  const x = (i: number) => M.left + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const y = (v: number) => M.top + ih - (v / yMax) * ih;
  const path = (vs: (number | null)[]) => {
    let d = "", pen = false;
    vs.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  let band = "";
  if (c.band) {
    const idx = c.band.hi.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
    if (idx.length) {
      band = idx.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(((c.band?.hi[i]) as number)).toFixed(1)}`).join("")
        + idx.slice().reverse().map((i) => `L${x(i).toFixed(1)},${y(((c.band?.lo[i]) as number)).toFixed(1)}`).join("") + "Z";
    }
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const step = Math.max(1, Math.round(n / Math.max(3, Math.floor(iw / 78))));
  const anchor = c.marker ? c.marker.index % step : 0;
  const xTicks = [];
  for (let i = anchor; i < n; i += step) xTicks.push(i);

  const g = html`
    ${ticks.map((t) => html`<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${y(t)}" y2="${y(t)}"></line>
      <text x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${int(t)}</text>`)}
    ${c.shade && c.shade.to > c.shade.from ? html`<rect class="lead" x="${x(c.shade.from)}" y="${M.top}" width="${x(Math.min(n - 1, c.shade.to)) - x(c.shade.from)}" height="${ih}"></rect>
      <text class="lead-label" x="${x(c.shade.from) + 6}" y="${M.top + 12}">${c.shade.label}</text>` : ""}
    ${band ? html`<path class="band" d="${band}"></path>` : ""}
    ${c.series.map((s) => html`<path class="${s.cls}" d="${path(s.values)}"></path>`)}
    ${c.marker ? html`<line class="today" x1="${x(c.marker.index)}" x2="${x(c.marker.index)}" y1="${M.top - 6}" y2="${M.top + ih}"></line>
      <text class="today-label" x="${x(c.marker.index) - 6}" y="${M.top - 6}" text-anchor="end">${c.marker.label}</text>` : ""}
    <line class="axis" x1="${M.left}" x2="${W - M.right}" y1="${M.top + ih}" y2="${M.top + ih}"></line>
    ${xTicks.map((i) => html`<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${shortDate(c.dates[i])}</text>`)}
    <g data-hover hidden><line class="hover-line" y1="${M.top}" y2="${M.top + ih}"></line></g>
    <rect data-hit x="${M.left}" y="${M.top}" width="${iw}" height="${ih}" fill="transparent"></rect>`;
  svg.innerHTML = `<desc>${c.desc.replace(/</g, "&lt;")}</desc>${g.s}`;

  const hover = (((($("[data-hover]", svg)) as unknown)) as SVGGElement);
  const hl = (((($(".hover-line", svg)) as unknown)) as SVGLineElement);
  const hit = (((($("[data-hit]", svg)) as unknown)) as SVGRectElement);
  const dots = c.series.map((s) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    el.setAttribute("r", "4");
    el.setAttribute("class", "hover-dot");
    el.style.fill = s.color;
    hover.append(el);
    return el;
  });
  const show = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / iw) * (n - 1))));
    hover.removeAttribute("hidden");
    hl.setAttribute("x1", String(x(i)));
    hl.setAttribute("x2", String(x(i)));
    c.series.forEach((s, k) => {
      const v = s.values[i];
      dots[k].style.display = v == null ? "none" : "";
      if (v != null) { dots[k].setAttribute("cx", String(x(i))); dots[k].setAttribute("cy", String(y(v))); }
    });
    setHTML(tip, html`<strong>${dayDate(c.dates[i])}</strong>
      ${c.series.filter((s) => s.values[i] != null).map((s) => html`<div>${s.label}<b class="num">${one((s.values[i] as number))}</b></div>`)}
      ${c.band && c.band.lo[i] != null ? html`<div>${c.band.label}<b class="num">${int((c.band.lo[i] as number))}–${int((c.band.hi[i] as number))}</b></div>` : ""}`);
    tip.hidden = false;
    const left = (x(i) / W) * r.width;
    tip.style.left = `${Math.min(r.width - tip.offsetWidth, Math.max(0, left + (left > r.width / 2 ? -tip.offsetWidth - 14 : 14)))}px`;
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", () => { hover.setAttribute("hidden", ""); tip.hidden = true; });
}

/** Chart frame markup: svg + tooltip. */
export const chartFrame = (id: string) =>
  html`<div class="chart-box" data-box="${id}"><svg class="chart-svg" data-svg="${id}" role="img"></svg><div class="chart-tip" data-tip="${id}" hidden></div></div>`;

/** Mount a redraw-on-resize chart into a frame. Returns {draw(spec), destroy()}. */
export function mountChart(root: HTMLElement, id: string) {
  const box = (($(`[data-box="${id}"]`, root)) as HTMLElement);
  const svg = (((($(`[data-svg="${id}"]`, root)) as unknown)) as SVGSVGElement);
  const tip = (($(`[data-tip="${id}"]`, root)) as HTMLElement);
  let spec: ChartSpec | null = null;
  let running: import("animejs").JSAnimation[] = [];
  let width = box.clientWidth;
  const ro = new ResizeObserver(() => {
    if (spec && Math.abs(box.clientWidth - width) > 4) { width = box.clientWidth; drawChart(svg, tip, width - 20, spec); }
  });
  ro.observe(box);
  return {
    /** @param o reveal: the chart shows different data (new SKU or horizon), so draw it in */
    draw(s: ChartSpec, o: {reveal?: boolean} = {}) {
      running.forEach((a) => a.revert?.());
      running = [];
      spec = s; width = box.clientWidth; drawChart(svg, tip, width - 20, s);
      if (o.reveal) running = revealChart(svg) || [];
    },
    destroy() { ro.disconnect(); running.forEach((a) => a.revert?.()); },
  };
}

/** Legend swatches. */
export const legend = (items: {label: string, cls: string}[]) =>
  html`<div class="chart-legend" aria-hidden="true">${items.map((i) => html`<span><i class="swatch ${i.cls}"></i>${i.label}</span>`)}</div>`;
