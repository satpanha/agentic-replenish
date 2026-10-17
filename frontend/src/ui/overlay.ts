/** Popovers, drawer and toasts: the floating layer. */
import { $, focusables, html, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { drawerIn, drawerOut, toastIn, toastOut } from "../lib/motion.js";

// ---- popovers ---------------------------------------------------------------------------------

let openPop: {btn: HTMLElement, pop: HTMLElement} | null = null;

export function closePopover(restoreFocus = false) {
  if (!openPop) return;
  const { btn, pop } = openPop;
  pop.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  openPop = null;
  if (restoreFocus) btn.focus();
}

/** Wire a button to toggle a popover. `render` fills it each time it opens. */
export function bindPopover(btn: HTMLElement, pop: HTMLElement, render?: () => void) {
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = openPop?.pop === pop;
    closePopover();
    if (isOpen) return;
    render?.();
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    openPop = { btn, pop };
    const first = ((pop.querySelector("button:not([disabled]), a[href]")) as HTMLElement | null);
    first?.focus();
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = (Array.from(pop.querySelectorAll(".menu-item:not([disabled])")) as HTMLElement[]);
    const i = items.indexOf((document.activeElement as HTMLElement));
    const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    n?.focus();
    e.preventDefault();
  });
}

document.addEventListener("click", (e) => {
  if (openPop && !openPop.pop.contains((e.target as Node))) closePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPop) closePopover(true);
});

// ---- drawer -----------------------------------------------------------------------------------

let drawer: {root: HTMLElement, returnTo: Element | null, onClose: () => void} | null = null;

export function openDrawer(o: {title: import("../lib/dom.js").Markup, body: import("../lib/dom.js").Markup, foot?: import("../lib/dom.js").Markup, onClose: () => void}) {
  const returnTo = drawer ? drawer.returnTo : document.activeElement;
  const refresh = !!drawer; // same drawer re-rendered with new data: swap without replaying the entrance
  closeDrawer(false, true);
  const root = document.createElement("div");
  setHTML(root, html`<div class="scrim" data-close></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header class="drawer-head"><div style="flex:1;min-width:0">${o.title}</div>
        <button class="btn btn-icon" data-close aria-label="Close details">${icon("x")}</button></header>
      <div class="drawer-body">${o.body}</div>
      ${o.foot ? html`<footer class="drawer-foot">${o.foot}</footer>` : ""}
    </aside>`);
  document.body.append(root);
  document.body.style.overflow = "hidden";
  drawer = { root, returnTo, onClose: o.onClose };
  root.addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-close]")) o.onClose();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); o.onClose(); }
    if (e.key === "Tab") trap(e, (($(".drawer", root)) as HTMLElement));
  });
  const aside = (($(".drawer", root)) as HTMLElement);
  aside.tabIndex = -1;
  if (!refresh) drawerIn((($(".scrim", root)) as HTMLElement), aside);
  (focusables(aside)[0] || aside).focus();
}

/**
 * @param restore return focus to the opener
 * @param instant skip the exit motion
 */
export function closeDrawer(restore: boolean = true, instant: boolean = false) {
  if (!drawer) return;
  const { root, returnTo: back } = drawer;
  drawer = null;
  document.body.style.overflow = "";
  if (instant) root.remove();
  else {
    root.style.pointerEvents = "none";
    drawerOut((($(".scrim", root)) as HTMLElement), (($(".drawer", root)) as HTMLElement), () => root.remove());
  }
  if (restore && back instanceof HTMLElement && document.contains(back)) back.focus();
}

export function trap(e: KeyboardEvent, box: HTMLElement) {
  const f = focusables(box);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

// ---- toasts -----------------------------------------------------------------------------------

export function toast(message: string, action?: {label: string, run: () => void}) {
  let host = $(".toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  const t = document.createElement("div");
  t.className = "toast";
  setHTML(t, html`${icon("checkCircle", "icon-sm")}<span>${message}</span>${action ? html`<button type="button">${action.label}</button>` : ""}`);
  if (action) t.querySelector("button")?.addEventListener("click", () => { action.run(); t.remove(); });
  host.append(t);
  toastIn(t);
  setTimeout(() => toastOut(t, () => t.remove()), 4200);
}
