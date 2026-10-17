/** Tiny templating: `html` escapes every interpolation unless it is already trusted markup. */

export class Markup {
  readonly s: string;
  constructor(s: string) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s: string) => new Markup(s);

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

function render(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return String(v); // aria-checked="${x}" etc.
  if (v instanceof Markup) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Markup {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += render(vals[i]);
  });
  return new Markup(out);
}

export const $ = (sel: string, root: ParentNode = document): HTMLElement | null => root.querySelector(sel);

export const $$ = (sel: string, root: ParentNode = document): HTMLElement[] => Array.from(root.querySelectorAll(sel));

/** Replace an element's children with markup. */
export function setHTML(el: Element, m: Markup) { el.innerHTML = m.s; }

/** Delegated event listener. */
export function on(root: Element | Document, type: string, sel: string, fn: (e: Event, target: HTMLElement) => void) {
  const handler = (e: Event) => {
    const t = ((e.target instanceof Element ? e.target.closest(sel) : null) as HTMLElement | null);
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, handler);
  return () => root.removeEventListener(type, handler);
}

/** Elements that can take focus, for focus traps. */
export function focusables(root: Element) {
  return ((Array.from(root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
  ))) as HTMLElement[]).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
