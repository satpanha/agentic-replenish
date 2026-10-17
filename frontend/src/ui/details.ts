/** Contextual drawers: product (SKU) detail and risk detail. */
import { html } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { METHOD_LABEL, cents, dayDate, int, money, one, parseDay, pct, shortDate } from "../lib/format.js";
import { DOC_TYPE_LABEL } from "../data/demo.js";
import { deliveryDate, explain, forecastUnits, runOutDate, statusOf, supplierMap } from "../data/model.js";
import { RISK_TYPES } from "../data/risk.js";
import { prov, statusBadge } from "./status.js";
import { severityChip, sparkline } from "./kit.js";

export function skuDrawer(d: import("../data/types.js").Dashboard, sku: string, s: import("../state.js").AppState) {
  const p = d.products.find((x) => x.sku === sku);
  if (!p) return null;
  const sup = supplierMap(d)[p.supplier_id];
  const st = statusOf(p);
  const r = p.recommendation;
  const inCart = !!s.cart[p.sku];
  const f = p.forecast;
  const margin = (p.unit_price - p.unit_cost) / p.unit_price;
  const hist = f.history;
  const pendingDocs = s.docs.filter((x) => ["needs_review", "uploaded"].includes(x.state) && x.lines.some((l) => l.sku === p.sku || (l.kind === "supplier" && x.supplier_id === p.supplier_id)));
  const events: {at: string, text: unknown, kind: string}[] = [
    ...(p.orders || []).flatMap((o) => (o.events || []).map((e) => ({ at: e.at, kind: "po", text: html`<a href="#/orders/${o.id}">PO-${String(o.id).padStart(5, "0")}</a> ${e.action === "created" ? "created" : e.action.replace("_", " ")} · ${int(o.qty)} units` }))),
    ...(p.updates || []).map((u) => ({ at: u.confirmed_at, kind: "update", text: html`${u.field.replace(/_/g, " ")} confirmed ${u.field === "unit_cost" ? `${cents(u.old_value ?? 0)} → ${cents(u.new_value)}` : `${int(u.old_value ?? 0)} → ${int(u.new_value)}`}` })),
    ...pendingDocs.map((x) => ({ at: x.received_at, kind: "doc", text: html`<a href="#/inbox/${x.id}">${DOC_TYPE_LABEL[x.type]}</a> received, waiting for review` })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 6);
  const costUpdates = (p.updates || []).filter((u) => u.field === "unit_cost");
  const pendingCost = pendingDocs.flatMap((x) => x.lines.filter((l) => l.sku === p.sku && l.fields.unit_cost != null && l.fields.unit_cost !== p.unit_cost).map((l) => ({ doc: x, l })));

  return {
    title: html`<div style="display:grid;gap:6px">
      <h2 id="drawer-title">${p.name}</h2>
      <span class="muted" style="font-size:var(--fs-sm)"><span class="mono">${p.sku}</span> · ${p.category} · ${sup.name}</span>
      <span>${statusBadge(st)}</span></div>`,
    body: html`
      <p class="callout ${st.level === "critical" ? "callout-critical" : ""}">${explain(d, p)}</p>

      <section class="drawer-section">
        <h3>Stock position ${prov("calc")}</h3>
        <dl class="facts">
          <div><dt>On hand</dt><dd class="num">${int(p.stock)}</dd></div>
          <div><dt>On order</dt><dd class="num">${int(p.on_order)}</dd></div>
          <div><dt>Days of supply</dt><dd class="num">${one(p.days_cover_incl_pipeline)} <small>incl. open orders</small></dd></div>
          <div><dt>Projected empty</dt><dd>${dayDate(runOutDate(d, p))}</dd></div>
          <div><dt>Lead time</dt><dd class="num">${int(p.lead_time_days)} <small>± ${one(p.lead_time_std_days)} days · arrives ${dayDate(deliveryDate(d, p))}</small></dd></div>
          <div><dt>Unit cost · margin</dt><dd class="num">${cents(p.unit_cost)} <small>${pct(margin, 0)} at ${cents(p.unit_price)}</small></dd></div>
        </dl>
      </section>

      <section class="drawer-section">
        <h3>Sales and forecast ${prov("calc")}</h3>
        <div class="spark-box">${sparkline(hist)}<div class="spark-axis"><span>${shortDate(parseDay(d.history_start))}</span><span>${int(hist.reduce((a, b) => a + b, 0))} units in ${hist.length} days</span><span>yesterday</span></div></div>
        <dl class="facts">
          <div><dt>Forecast demand</dt><dd class="num">${one(p.daily_forecast)} <small>/ day · ${int(forecastUnits(p, s.period))} over ${s.period} days</small></dd></div>
          <div><dt>Model · error</dt><dd style="font-size:var(--fs-sm)">${METHOD_LABEL[f.method] || f.method} <small>WAPE ${pct(f.wape)}${f.sma14_wape != null ? ` vs SMA-14 ${pct(f.sma14_wape)}` : ""}</small></dd></div>
        </dl>
      </section>

      <section class="drawer-section">
        <h3>Reorder recommendation ${prov("calc")}</h3>
        ${r ? html`
          <dl class="facts">
            <div><dt>Order quantity</dt><dd class="num">${int(r.qty)} <small>${r.qty / p.pack_size} cases of ${p.pack_size}</small></dd></div>
            <div><dt>Estimated cost</dt><dd class="num">${cents(r.line_cost)}</dd></div>
            <div><dt>Reorder point</dt><dd class="num">${int(r.reorder_point)}</dd></div>
            <div><dt>Safety stock</dt><dd class="num">${int(r.safety_stock)}</dd></div>
          </dl>
          <p class="muted" style="font-size:var(--fs-xs);margin-top:8px">Order-up-to policy at ${pct(d.policy.service_level, 0)} service level, ${d.policy.review_days}-day review, rounded to case ${p.pack_size} and MOQ ${p.moq}. Supplier minimum ${money(sup.min_order_value)}. Before budget limits; the cart shows the budgeted plan.</p>`
        : html`<p class="callout">No order needed this cycle. Stock and open orders stay above the reorder point through the next review.</p>`}
      </section>

      <section class="drawer-section">
        <h3>Supplier cost changes</h3>
        ${costUpdates.length || pendingCost.length ? html`<ul class="mini-list">
          ${costUpdates.map((u) => html`<li><span class="prov prov-calc">Confirmed</span> ${cents(u.old_value ?? 0)} → <b>${cents(u.new_value)}</b> <span class="muted">${u.source_doc || ""} · ${shortDate(new Date(u.confirmed_at))}</span></li>`)}
          ${pendingCost.map(({ doc, l }) => html`<li><span class="prov prov-ai">Unconfirmed</span> ${cents(p.unit_cost)} → <b>${cents((l.fields.unit_cost as number))}</b> <a href="#/inbox/${doc.id}">review ${DOC_TYPE_LABEL[doc.type].toLowerCase()}</a></li>`)}
        </ul>` : html`<p class="muted" style="font-size:var(--fs-sm)">No cost changes on file for this product.</p>`}
      </section>

      <section class="drawer-section">
        <h3>Recent events</h3>
        ${events.length ? html`<ol class="timeline">${events.map((e) => html`<li><span class="tl-dot tl-${e.kind}"></span><div><b>${e.text}</b><span class="muted">${shortDate(new Date(e.at))}</span></div></li>`)}</ol>`
          : html`<p class="muted" style="font-size:var(--fs-sm)">No orders, confirmed updates or documents for this product yet.</p>`}
      </section>

      ${p.earliest_expiry_date ? html`<section class="drawer-section"><h3>Shelf life</h3><dl class="facts">
        <div><dt>Earliest expiry</dt><dd>${dayDate(parseDay(p.earliest_expiry_date))}</dd></div>
        <div><dt>Shelf life</dt><dd class="num">${int(p.shelf_life_days || 0)} <small>days</small></dd></div></dl></section>` : ""}`,
    foot: html`
      <div class="drawer-links">
        <button class="btn btn-ghost btn-sm" type="button" data-action="view-forecast" data-arg="${p.sku}">${icon("trend", "icon-xs")}View Forecast</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="go" data-arg="inbox?supplier=${p.supplier_id}">${icon("inbox", "icon-xs")}Inspect Supplier</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="ask" data-arg="${p.sku}">${icon("scan", "icon-xs")}Ask</button>
      </div>
      ${inCart ? html`<button class="btn btn-primary" type="button" data-action="go" data-arg="cart?sku=${p.sku}">${icon("cart", "icon-sm")}Review Reorder Recommendation</button>`
        : html`<button class="btn btn-primary" type="button" data-action="add-cart" data-arg="${p.sku}">${icon("plus", "icon-sm")}Add ${r ? int(r.qty) : "to cart"}${r ? " to cart" : ""}</button>`}`,
  };
}

export function riskDrawer(r: import("../data/risk.js").RiskItem) {
  return {
    title: html`<div style="display:grid;gap:6px">
      <h2 id="drawer-title">${r.title}</h2>
      <span class="muted" style="font-size:var(--fs-sm)">${r.subject.name}${r.subject.kind === "sku" ? html` · <span class="mono">${r.subject.id}</span>` : " · supplier"} · ${RISK_TYPES.find((t) => t.id === r.type)?.label}</span>
      <span style="display:flex;gap:8px;align-items:center">${severityChip(r.severity)}${prov(r.source)}</span></div>`,
    body: html`
      <section class="drawer-section"><h3>Current measurement</h3><p class="big-measure num">${r.measure}</p>${r.leadTime != null ? html`<p class="muted">Supplier lead time ${int(r.leadTime)} days</p>` : ""}</section>
      <section class="drawer-section"><h3>Evidence ${prov(r.source)}</h3><ul class="mini-list">${r.evidence.map((e) => html`<li>${e}</li>`)}</ul></section>
      <section class="drawer-section"><h3>Expected impact</h3><p class="callout ${r.severity === "critical" ? "callout-critical" : ""}">${r.impact}</p></section>
      ${r.note ? html`<section class="drawer-section"><h3>Data limitation</h3><p class="callout">${icon("info", "icon-xs")} ${r.note}</p></section>` : ""}
      <section class="drawer-section"><h3>Rule applied</h3><p class="muted" style="font-size:var(--fs-sm)">${r.rule}</p></section>`,
    foot: html`
      <div class="drawer-links">
        ${r.subject.kind === "sku" ? html`<button class="btn btn-ghost btn-sm" type="button" data-action="view-forecast" data-arg="${r.subject.id}">${icon("trend", "icon-xs")}View Forecast</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="open-sku" data-arg="${r.subject.id}">${icon("package", "icon-xs")}Product</button>`
        : html`<button class="btn btn-ghost btn-sm" type="button" data-action="go" data-arg="inventory?supplier=${r.subject.id}">${icon("package", "icon-xs")}Its products</button>`}
        <button class="btn btn-ghost btn-sm" type="button" data-action="go" data-arg="inbox?supplier=${r.subject.supplier_id}">${icon("inbox", "icon-xs")}Supplier documents</button>
      </div>
      <button class="btn btn-primary" type="button" data-action="${r.next.action === "open-risk" ? (r.subject.kind === "sku" ? "add-cart" : "go") : r.next.action}" data-arg="${r.next.action === "open-risk" ? (r.subject.kind === "sku" ? r.subject.id : "cart") : r.next.arg}">${r.next.action === "open-risk" ? (r.subject.kind === "sku" ? "Add to Purchasing Cart" : "Open Purchasing Cart") : r.next.label}</button>`,
  };
}

