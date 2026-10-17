/** Purchasing Cart: review, adjust and turn recommended orders into purchase order drafts. */
import { $, html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { cents, int, money, one, pct, plural } from "../lib/format.js";
import { cartSummary } from "../data/cart.js";
import { getOptimization } from "../data/optimizer.js";
import { createDrafts } from "../data/api.js";
import { statusOf } from "../data/model.js";
import { addToCart, go, load, loadCart, openAssistant, removeFromCart, setCartQty, store } from "../state.js";
import { statusBadge, prov } from "../ui/status.js";
import { emptyState, pageHead } from "../ui/kit.js";
import { toast } from "../ui/overlay.js";
import { enterBlock, highlight, leave, meter, settle } from "../lib/motion.js";

export function mountCart(root: HTMLElement) {
  document.title = "Purchasing Cart · StockPulse AMD";
  const focusSku = store.get().routeParams.sku || null;
  const sim: {budget: number | null, delaySupplier: string, delayDays: number} = { budget: null, delaySupplier: "", delayDays: 0 };
  let current: import("../data/types.js").Optimization | null = null;   // optimizer at the saved weekly budget
  let simulated: import("../data/types.js").Optimization | null = null; // optimizer at the simulated settings
  let simError = "";
  const why = new Set(focusSku ? [focusSku] : []);
  let busy = false;
  let alive = true;
  let dragging = false; // budget slider held: re-render after release so the drag isn't interrupted
  /** What was on screen last render, so motion only marks what actually changed. */
  let prev: null | {lines: Map<string, number>, figures: string[], meter: number, planKey: string, blockers: string} = null;
  const planMemo: {key: string, spend: number, before: number | null} = { key: "", spend: 0, before: null };

  async function refreshOpt() {
    const s = store.get();
    if (!s.data) return;
    try {
      current = await getOptimization(s.settings.budget);
      const lt = sim.delaySupplier && sim.delayDays ? { [sim.delaySupplier]: (s.data.suppliers.find((x) => x.supplier_id === sim.delaySupplier)?.lead_time_days || 0) + sim.delayDays } : {};
      simulated = sim.budget == null && !Object.keys(lt).length ? null : await getOptimization(sim.budget ?? s.settings.budget, lt);
      simError = "";
    } catch (e) {
      simError = e instanceof Error ? e.message : String(e);
    }
    if (alive && !dragging) render();
  }

  function render() {
    const s = store.get();
    if (!s.data) { setHTML(root, html`<div class="panel">${emptyState({ title: "Loading the engine…", iconName: "refresh" })}</div>`); return; }
    const d = s.data;
    const optBy = Object.fromEntries((current?.lines || []).map((l) => [l.sku, l]));
    const sum = cartSummary(d, s.cart, s.settings.budget, optBy);
    const keep = (document.activeElement as HTMLElement | null)?.dataset?.key;

    setHTML(root, html`
      ${pageHead({
        title: "Purchasing Cart",
        sub: "Review and adjust order lines, test the budget, then generate purchase order drafts. Quantities and costs come from the calculation layer.",
        actions: html`<button class="btn btn-secondary" type="button" data-ask>${icon("scan", "icon-sm")}Ask the assistant</button>
          <button class="btn btn-primary" type="button" data-generate ${sum.canGenerate && !busy ? "" : "disabled"} aria-describedby="gen-why">${icon("file", "icon-sm")}${busy ? "Creating drafts…" : "Generate Purchase Order Draft"}</button>`,
      })}

      <div class="cart-top">
        <section class="panel budget-panel" aria-labelledby="bud-title">
          <div class="panel-head"><div><h2 class="panel-title" id="bud-title">Budget</h2><p class="panel-sub">Totals recalculate from the lines below.</p></div>${prov("calc")}</div>
          <dl class="budget-grid">
            <div><dt>Weekly budget</dt><dd class="num">${money(sum.budget)}</dd></div>
            <div><dt>Proposed spend</dt><dd class="num">${cents(sum.spend)}</dd></div>
            <div class="${sum.remaining < 0 ? "is-bad" : ""}"><dt>${sum.remaining < 0 ? "Over budget" : "Remaining"}</dt><dd class="num">${cents(Math.abs(sum.remaining))}</dd></div>
            <div><dt>Utilisation</dt><dd class="num">${sum.utilisation == null ? "n/a" : pct(sum.utilisation, 0)}</dd></div>
            <div><dt>Order lines</dt><dd class="num">${int(sum.count)}${sum.edited ? html` <small>${sum.edited} edited</small>` : ""}</dd></div>
            <div class="${sum.violations ? "is-bad" : ""}"><dt>Constraint issues</dt><dd class="num">${int(sum.violations)}</dd></div>
          </dl>
          <div class="panel-body">
            <div class="meter meter-lg" data-budget-meter role="meter" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((sum.utilisation || 0) * 100)}">
              <i style="width:${Math.min(100, (sum.utilisation || 0) * 100)}%;background:${(sum.utilisation || 0) > 1 ? "var(--red)" : (sum.utilisation || 0) > 0.9 ? "var(--amber)" : "var(--indigo)"}"></i>
            </div>
            <div id="gen-why" class="blockers" aria-live="polite">
              ${sum.blockers.length ? html`<p class="blockers-title">${icon("alert", "icon-sm")}Resolve before generating a draft:</p><ul>${sum.blockers.map((b) => html`<li>${b}</li>`)}</ul>`
                : sum.included.length ? html`<p class="ok-line">${icon("checkCircle", "icon-sm")}All lines meet pack size, MOQ, supplier minimum and budget rules.</p>` : ""}
            </div>
          </div>
        </section>
        ${simulator(s, sum)}
      </div>

      <section class="panel" aria-labelledby="lines-title">
        <div class="panel-head">
          <div><h2 class="panel-title" id="lines-title">Order lines</h2><p class="panel-sub">${sum.lines.length ? `${plural(sum.lines.length, "line")} from ${plural(sum.groups.length, "supplier")}` : "Nothing staged yet"}</p></div>
          ${addControl(d, s.cart)}
        </div>
        ${sum.lines.length ? linesTable(sum, why, focusSku) : html`<div class="cart-empty">${emptyState({
          title: "Your cart is empty",
          body: html`Start from the optimizer's plan for your ${money(s.settings.budget)} budget, or add products from the Overview, Inventory or Risk Radar.`,
          iconName: "cart",
          action: html`<div class="row-actions"><button class="btn btn-primary" type="button" data-load-plan ${current ? "" : "disabled"}>${icon("plus", "icon-sm")}Load optimized order${current ? ` · ${plural(current.lines.filter((l) => l.qty).length, "line")}` : ""}</button>
            <a class="btn btn-secondary" href="#/inventory">Browse inventory</a></div>`,
        })}</div>`}
      </section>

      ${current ? html`<details class="assumptions"><summary>${prov("calc")} How the optimizer works: greedy heuristic, not a MILP solver</summary><ul>${current.assumptions.map((a) => html`<li>${a}</li>`)}</ul>
        <p>Service level ${pct(current.service_level, 0)}, review every ${current.review_days} days (engine policy).</p></details>` : ""}`);

    if (keep) (root.querySelector(`[data-key="${keep}"]`) as HTMLElement | null)?.focus();
    animateChanges(sum);
    if (focusSku && !root.dataset.scrolled) {
      root.dataset.scrolled = "1";
      root.querySelector(`[data-line="${focusSku}"]`)?.scrollIntoView({ block: "center" });
    }
  }

  /** Point at what changed since the last render. Values are already final; motion only draws the eye. */
  function animateChanges(sum: ReturnType<typeof cartSummary>) {
    const figures = [...root.querySelectorAll(".budget-grid dd")];
    const bar = ((root.querySelector("[data-budget-meter] > i")) as HTMLElement | null);
    const plan = simulated || current;
    const planKey = plan ? `${plan.budget}|${plan.spend}|${plan.counts.full}|${plan.counts.reduced}|${plan.counts.deferred}` : "";
    const blockers = root.querySelector("#gen-why")?.textContent?.trim() || "";
    if (prev) {
      const p = prev;
      const rowsOf = (sku: string) => [...root.querySelectorAll(`tr[data-line="${sku}"], tr[data-line="${sku}"] + tr.line-detail`)];
      for (const l of sum.lines) {
        if (!p.lines.has(l.sku)) enterBlock(rowsOf(l.sku), { max: 2 });
        else if (p.lines.get(l.sku) !== l.line.qty) {
          highlight(rowsOf(l.sku), l.blocking ? "red" : "indigo");
          settle(root.querySelectorAll(`tr[data-line="${l.sku}"] td[data-label="Extended"] b`)[0] || []);
        }
      }
      settle(figures.filter((el, i) => el.textContent !== p.figures[i]));
      if (bar) meter(bar, p.meter);
      if (planKey && planKey !== p.planKey) enterBlock(root.querySelectorAll(".sim-compare > div:not(.arrow), .sim-changes li"), { stagger: 30, max: 9 });
      if (blockers && blockers !== p.blockers) enterBlock(root.querySelectorAll("#gen-why > *"));
    }
    prev = {
      lines: new Map(sum.lines.map((l) => [l.sku, l.line.qty])), figures: figures.map((el) => el.textContent || ""),
      meter: bar ? parseFloat(bar.style.width) || 0 : 0, planKey, blockers,
    };
  }

  // ---- simulator ------------------------------------------------------------------------------
  function simulator(s: import("../state.js").AppState, sum: ReturnType<typeof cartSummary>) {
    const d = (s.data as import("../data/types.js").Dashboard);
    const b = sim.budget ?? s.settings.budget;
    const maxB = Math.max(1000, Math.ceil(((current?.unconstrained_spend || s.settings.budget) * 1.6) / 500) * 500);
    const cartBy = s.cart;
    const plan = simulated || current;
    const changes = plan ? plan.lines.map((l) => ({ l, now: cartBy[l.sku]?.qty ?? 0 })).filter((x) => x.now !== x.l.qty) : [];
    const protectedCrit = plan ? plan.lines.filter((l) => l.tier === 0 && l.qty > 0) : [];
    const crit = plan ? plan.lines.filter((l) => l.tier === 0) : [];
    const active = sim.budget != null || (sim.delaySupplier && sim.delayDays);
    const key = plan ? `${plan.budget}|${JSON.stringify(plan.lead_time_overrides)}` : "";
    if (plan && key !== planMemo.key) { planMemo.before = planMemo.key ? planMemo.spend : null; planMemo.key = key; planMemo.spend = plan.spend; }
    return html`<section class="panel sim-panel" aria-labelledby="sim-title">
      <div class="panel-head">
        <div><h2 class="panel-title" id="sim-title">What-if simulator</h2><p class="panel-sub">Re-runs the optimizer on the same data. Nothing changes until you apply it.</p></div>
        ${prov("calc")}
      </div>
      <div class="sim-controls">
        <div class="field">
          <label for="sim-budget">Weekly budget</label>
          <div class="sim-budget">
            <input type="range" id="sim-range" min="0" max="${maxB}" step="100" value="${b}" aria-label="Simulated weekly budget" data-key="sim-range">
            <span class="input-prefix"><span>$</span><input class="input num" id="sim-budget" type="number" min="0" step="100" value="${Math.round(b)}" data-key="sim-budget"></span>
          </div>
          <div class="chips">
            ${[-30, -15, 15].map((p) => html`<button class="btn btn-sm btn-secondary" type="button" data-sim-pct="${p}">${p > 0 ? "+" : ""}${p}%</button>`)}
          </div>
        </div>
        <div class="field">
          <label for="sim-sup">Supplier delay</label>
          <div class="sim-delay">
            <select class="select" id="sim-sup" data-key="sim-sup"><option value="">No delay</option>${d.suppliers.map((x) => html`<option value="${x.supplier_id}" ${x.supplier_id === sim.delaySupplier ? "selected" : ""}>${x.name} (${int(x.lead_time_days)}d)</option>`)}</select>
            <span class="input-suffix"><span>+</span><input class="input num" id="sim-days" type="number" min="0" max="30" step="1" value="${sim.delayDays}" aria-label="Extra lead-time days" data-key="sim-days" ${sim.delaySupplier ? "" : "disabled"}><span>days</span></span>
          </div>
        </div>
      </div>
      ${simError ? html`<p class="callout callout-critical" style="margin:0 20px 16px">${simError}</p>` : plan ? html`
        <div class="sim-compare">
          <div><span>Cart now</span><b class="num">${cents(sum.spend)}</b><small>${plural(sum.count, "line")}</small></div>
          <div class="arrow" aria-hidden="true">${icon("arrowRight", "icon-sm")}</div>
          <div><span>${active ? "Simulated plan" : "Optimized plan"}</span><b class="num">${cents(plan.spend)}</b><small>${plan.counts.full} full · ${plan.counts.reduced} reduced · ${plan.counts.deferred} deferred</small>${planMemo.before != null && planMemo.before !== plan.spend ? html`<small class="was num">was ${cents(planMemo.before)}</small>` : ""}</div>
          <div><span>Critical SKUs protected</span><b class="num">${protectedCrit.length} of ${crit.length}</b><small>run out before delivery otherwise</small></div>
        </div>
        <div class="sim-changes">
          ${changes.length ? html`<ul>${changes.slice(0, 6).map(({ l, now }) => html`<li>
              <b>${l.name}</b> ${int(now)} → ${int(l.qty)}
              <span class="muted">${l.status === "deferred" ? `deferred: about ${int(l.shortfall_units_if_deferred)} units short, ${money(l.margin_at_risk_if_deferred)} margin at risk` : l.status === "reduced" ? "reduced: no safety stock" : now ? "back to the full policy quantity" : "added by the plan"}</span></li>`)}</ul>
            ${changes.length > 6 ? html`<p class="muted" style="font-size:var(--fs-xs)">+${changes.length - 6} more changes</p>` : ""}`
          : html`<p class="muted">The cart already matches this plan.</p>`}
        </div>
        <div class="panel-foot">
          <button class="btn btn-ghost btn-sm" type="button" data-sim-reset ${active ? "" : "disabled"}>${icon("refresh", "icon-xs")}Reset simulation</button>
          <button class="btn btn-secondary btn-sm" type="button" data-sim-apply ${changes.length || (sim.budget != null && sim.budget !== s.settings.budget) ? "" : "disabled"}>Apply ${sim.budget != null && sim.budget !== s.settings.budget ? "plan and budget" : "plan"} to cart</button>
        </div>` : html`<div class="panel-body"><div class="skeleton sk-block" style="height:120px"></div></div>`}
    </section>`;
  }

  // ---- events ---------------------------------------------------------------------------------
  const debounce = (fn: () => void, ms = 250) => { let t = 0; return () => { clearTimeout(t); t = window.setTimeout(fn, ms); }; };
  const rerunSim = debounce(() => refreshOpt());

  on(root, "pointerdown", "#sim-range", () => { dragging = true; });
  const release = () => { if (dragging) { dragging = false; if (alive) render(); } };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  on(root, "input", "#sim-range", (_e, t) => {
    sim.budget = Number((t as HTMLInputElement).value);
    const n = (($("#sim-budget", root)) as HTMLInputElement | null);
    if (n) n.value = String(sim.budget);
    rerunSim();
  });
  on(root, "change", "#sim-budget", (_e, t) => {
    const v = Number((t as HTMLInputElement).value);
    if (Number.isFinite(v) && v >= 0) { sim.budget = Math.round(v); refreshOpt(); }
  });
  on(root, "click", "[data-sim-pct]", (_e, t) => {
    sim.budget = Math.round(store.get().settings.budget * (1 + Number(t.dataset.simPct) / 100));
    refreshOpt();
  });
  on(root, "change", "#sim-sup", (_e, t) => { sim.delaySupplier = (t as HTMLSelectElement).value; if (!sim.delayDays && sim.delaySupplier) sim.delayDays = 5; refreshOpt(); });
  on(root, "change", "#sim-days", (_e, t) => { sim.delayDays = Math.max(0, Math.min(30, Math.round(Number((t as HTMLInputElement).value) || 0))); refreshOpt(); });
  on(root, "click", "[data-sim-reset]", () => { sim.budget = null; sim.delaySupplier = ""; sim.delayDays = 0; simulated = null; refreshOpt(); });
  on(root, "click", "[data-sim-apply]", () => {
    const plan = simulated || current;
    if (!plan) return;
    if (sim.budget != null) store.set({ settings: { ...store.get().settings, budget: sim.budget } });
    loadCart(plan.lines);
    toast(`Cart replaced with the ${simulated ? "simulated" : "optimized"} plan: ${plural(plan.lines.filter((l) => l.qty).length, "line")}, ${cents(plan.spend)}`);
    sim.budget = null;
    if (!(sim.delaySupplier && sim.delayDays)) simulated = null;
    refreshOpt();
  });
  on(root, "click", "[data-load-plan]", () => {
    if (!current) return;
    loadCart(current.lines);
    toast(`Loaded the optimized order: ${plural(current.lines.filter((l) => l.qty).length, "line")}, ${cents(current.spend)}`);
  });

  // line edits
  on(root, "change", "[data-qty]", (_e, t) => {
    const raw = (t as HTMLInputElement).value.trim();
    setCartQty((t.dataset.qty as string), raw === "" ? NaN : Number(raw));
  });
  on(root, "keydown", "[data-qty]", (e, t) => { if ((e as KeyboardEvent).key === "Enter") t.dispatchEvent(new Event("change", { bubbles: true })); });
  on(root, "click", "[data-step]", (_e, t) => {
    const sku = (t.dataset.sku as string);
    const p = store.get().data?.products.find((x) => x.sku === sku);
    const line = store.get().cart[sku];
    if (!p || !line) return;
    const base = Number.isFinite(line.qty) ? line.qty : 0;
    const dir = Number(t.dataset.step);
    // step to the next whole case in that direction
    const next = dir > 0 ? Math.floor(base / p.pack_size) * p.pack_size + p.pack_size : Math.ceil(base / p.pack_size) * p.pack_size - p.pack_size;
    setCartQty(sku, Math.max(0, next));
  });
  on(root, "click", "[data-fix]", (_e, t) => setCartQty((t.dataset.sku as string), Number(t.dataset.fix)));
  on(root, "click", "[data-restore]", (_e, t) => {
    const sku = (t.dataset.restore as string);
    const line = store.get().cart[sku];
    if (line?.rec != null) setCartQty(sku, line.rec);
  });
  on(root, "click", "[data-remove]", (_e, t) => {
    const sku = (t.dataset.remove as string);
    const line = store.get().cart[sku];
    const rows = [...root.querySelectorAll(`tr[data-line="${sku}"], tr[data-line="${sku}"] + tr.line-detail`)];
    leave(rows, () => {
      removeFromCart(sku);
      toast("Line removed", { label: "Undo", run: () => store.set({ cart: { ...store.get().cart, [sku]: line } }) });
    });
  });
  on(root, "click", "[data-why]", (_e, t) => {
    const sku = (t.dataset.why as string);
    why.has(sku) ? why.delete(sku) : why.add(sku);
    render();
  });
  on(root, "click", "[data-add-line]", () => {
    const sel = (($("#add-sku", root)) as HTMLSelectElement | null);
    if (!sel?.value) return;
    addToCart([sel.value]);
    toast("Line added");
  });
  on(root, "click", "[data-ask]", () => openAssistant(null, "Which products can be prioritized within the current budget?"));

  on(root, "click", "[data-generate]", async () => {
    const s = store.get();
    if (!s.data) return;
    const sum = cartSummary(s.data, s.cart, s.settings.budget);
    if (!sum.canGenerate) return;
    busy = true;
    render();
    try {
      const res = await createDrafts({
        lines: sum.included.map((l) => ({ sku: l.sku, qty: l.line.qty, recommended_qty: l.line.rec })),
        budget: s.settings.budget, note: `Built in the Purchasing Cart (${plural(sum.edited, "edited line")})`,
      });
      const done = new Set(sum.included.map((l) => l.sku));
      store.set({ cart: Object.fromEntries(Object.entries(store.get().cart).filter(([sku]) => !done.has(sku))) });
      toast(`${plural(res.created.length, "purchase order draft")} created. Submit for approval next.`);
      load();
      go(res.created.length === 1 ? `orders/${res.created[0].id}` : `orders?created=${res.created.map((p) => p.id).join(",")}`);
    } catch (e) {
      toast(`Couldn't create drafts: ${e instanceof Error ? e.message : e}`);
    } finally {
      busy = false;
      if (alive) render();
    }
  });

  render();
  refreshOpt();
  const unsub = store.subscribe((_s, ch) => {
    if (ch.has("data")) { current = null; simulated = null; refreshOpt(); }
    else if (ch.has("settings")) refreshOpt();
    else if (ch.has("cart")) render();
  });
  return () => { alive = false; unsub(); document.removeEventListener("pointerup", release); document.removeEventListener("pointercancel", release); };
}

function addControl(d: import("../data/types.js").Dashboard, cart: Record<string, import("../state.js").CartLine>) {
  const eligible = d.products.filter((p) => !cart[p.sku]).sort((a, b) => (a.recommendation ? 0 : 1) - (b.recommendation ? 0 : 1) || statusOf(a).rank - statusOf(b).rank || a.name.localeCompare(b.name));
  if (!eligible.length) return "";
  return html`<div class="add-line">
    <label class="visually-hidden" for="add-sku">Add a product</label>
    <select class="select" id="add-sku">
      ${eligible.map((p) => html`<option value="${p.sku}">${p.name}${p.recommendation ? ` · recommended ${int(p.recommendation.qty)}` : ""}</option>`)}
    </select>
    <button class="btn btn-secondary" type="button" data-add-line>${icon("plus", "icon-sm")}Add line</button>
  </div>`;
}

function linesTable(sum: ReturnType<typeof cartSummary>, why: Set<string>, focusSku: string | null) {
  return html`<div class="table-wrap">
    <table class="ptable cart-table">
      <thead><tr>
        <th scope="col">Product</th><th scope="col" class="r">Stock</th><th scope="col" class="r">Days of supply</th>
        <th scope="col" class="r">Forecast<span class="th-sub">lead + review</span></th><th scope="col" class="r">Recommended</th>
        <th scope="col">Final quantity</th><th scope="col" class="r">MOQ · case</th><th scope="col" class="r">Unit cost</th>
        <th scope="col" class="r">Extended</th><th scope="col">Risk</th><th scope="col"><span class="visually-hidden">Actions</span></th>
      </tr></thead>
      ${sum.groups.map((g) => html`<tbody>
        <tr class="group-row"><th scope="rowgroup" colspan="11">
          <span class="group-name">${g.supplier.name}</span>
          <span class="muted">${int(g.supplier.lead_time_days)}-day lead time · minimum order ${money(g.supplier.min_order_value)}</span>
          <span class="group-total num ${g.belowMinimum ? "is-bad" : ""}">${g.belowMinimum ? html`${icon("alert", "icon-xs")}Below minimum · ` : ""}${cents(g.subtotal)}</span>
        </th></tr>
        ${g.lines.map((l) => lineRows(l, why.has(l.sku), focusSku === l.sku))}
      </tbody>`)}
      <tfoot><tr><td colspan="8" class="r"><b>Proposed spend</b> <span class="muted">(Σ final quantity × unit cost)</span></td><td class="r num"><b>${cents(sum.spend)}</b></td><td colspan="2"></td></tr></tfoot>
    </table>
  </div>`;
}

function lineRows(l: ReturnType<typeof cartSummary>["lines"][number], open: boolean, focus: boolean) {
  const p = l.p;
  const o = l.opt;
  const qtyOk = Number.isFinite(l.line.qty);
  const reason = o ? o.reason : p.recommendation ? "Below its reorder point at this review." : "Added by hand: the policy does not call for an order this cycle.";
  return html`
    <tr class="line-row ${l.blocking ? "has-error" : ""} ${focus ? "is-focus" : ""}" data-line="${l.sku}">
      <td><div class="prod"><strong>${p.name}</strong><small><span class="mono">${p.sku}</span> · ${p.category}</small></div></td>
      <td class="r num" data-label="Stock">${int(p.stock)}${p.on_order ? html`<span class="cell-sub">+${int(p.on_order)} on order</span>` : ""}</td>
      <td class="r num" data-label="Days of supply">${one(p.days_cover_incl_pipeline)}d<span class="cell-sub">lead ${int(p.lead_time_days)}d</span></td>
      <td class="r num" data-label="Forecast, lead + review">${int(l.demand)}</td>
      <td class="r num" data-label="Recommended">${l.line.rec != null ? int(l.line.rec) : html`<span class="dash">-</span>`}</td>
      <td class="qty-cell" data-label="Final quantity">
        <div class="qty">
          <button class="btn btn-icon btn-sm" type="button" data-step="-1" data-sku="${l.sku}" aria-label="One case less">−</button>
          <input class="input num ${l.blocking ? "is-invalid" : ""}" type="number" inputmode="numeric" min="0" step="${p.pack_size}" value="${qtyOk ? l.line.qty : ""}"
            data-qty="${l.sku}" data-key="qty-${l.sku}" aria-label="Final quantity for ${p.name}" aria-invalid="${l.blocking}" aria-describedby="iss-${l.sku}">
          <button class="btn btn-icon btn-sm" type="button" data-step="1" data-sku="${l.sku}" aria-label="One case more">+</button>
        </div>
        ${l.line.edited ? html`<span class="edited">Edited${l.line.rec != null ? html` · <button class="btn-link btn" type="button" data-restore="${l.sku}">restore ${int(l.line.rec)}</button>` : ""}</span>` : ""}
      </td>
      <td class="r num" data-label="MOQ · case">${int(p.moq)}<span class="cell-sub">case ${p.pack_size}</span></td>
      <td class="r num" data-label="Unit cost">${cents(p.unit_cost)}</td>
      <td class="r num" data-label="Extended">${html`<b>${cents(l.cost)}</b>`}</td>
      <td class="risk-cell">${statusBadge(l.status)}</td>
      <td class="r rm-cell"><button class="btn btn-icon btn-sm" type="button" data-remove="${l.sku}" aria-label="Remove ${p.name}">${icon("x", "icon-xs")}</button></td>
    </tr>
    <tr class="line-detail ${l.blocking ? "has-error" : ""}"><td colspan="11">
      <div class="line-meta" id="iss-${l.sku}">
        ${l.issues.map((i) => html`<span class="issue issue-${i.level}">${icon(i.level === "error" ? "octagon" : "alert", "icon-xs")}${i.msg}
          ${(i.fixes || []).map((f) => html`<button class="btn btn-sm btn-secondary" type="button" data-fix="${f.qty}" data-sku="${l.sku}">${f.label}</button>`)}</span>`)}
        <span class="reason">${reason}</span>
        <button class="btn btn-link btn-sm" type="button" data-why="${l.sku}" aria-expanded="${open}">${open ? "Hide" : "Why this quantity?"}</button>
      </div>
      ${open ? whyPanel(l) : ""}
    </td></tr>`;
}

function whyPanel(l: ReturnType<typeof cartSummary>["lines"][number]) {
  const p = l.p, o = l.opt;
  if (!o) {
    return html`<div class="why">${prov("calc")}<p>Stock and open orders (${int(p.stock + p.on_order)}) cover ${one(p.days_cover_incl_pipeline)} days against a ${int(p.lead_time_days)}-day lead time, so the order-up-to policy doesn't trigger this cycle. Any quantity here is your call; it still has to be a whole number of cases of ${p.pack_size} and at least the MOQ of ${int(p.moq)}.</p></div>`;
  }
  const need = Math.max(0, o.order_up_to - o.position);
  return html`<div class="why">
    <div class="why-eq" aria-label="Order quantity calculation">
      <span><b class="num">${int(o.demand_over_lead_time)}</b>demand over ${int(o.lead_time_days)}-day lead time</span><i>+</i>
      <span><b class="num">${int(o.demand_over_review)}</b>demand over ${o.review_days}-day review</span><i>+</i>
      <span><b class="num">${int(o.safety_stock)}</b>safety stock</span><i>−</i>
      <span><b class="num">${int(o.position)}</b>stock + on order</span><i>=</i>
      <span><b class="num">${int(need)}</b>needed</span><i>→</i>
      <span class="hl"><b class="num">${int(o.recommended_qty)}</b>rounded to cases of ${o.pack_size}, MOQ ${o.moq}</span>
    </div>
    <p>${prov("calc")} ${o.reason} ${o.status !== "full" ? `At the ${money(store.get().settings.budget)} budget the optimizer funds ${int(o.qty)} (priority ${o.priority}).` : ""}
      ${l.line.edited && Number.isFinite(l.line.qty) ? html` You set <b>${int(l.line.qty)}</b>: about <b>${one((o.position + l.line.qty) / Math.max(o.daily_forecast, 0.01))}</b> days of cover after delivery, against ${one(o.cover_after_days)} with the plan.` : ""}</p>
  </div>`;
}
