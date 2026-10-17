/** Settings & Integrations: budget, engine policy (read-only), data source, confirmed updates, connections. */
import { html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { cents, int, money, pct, shortDate } from "../lib/format.js";
import { dataStatus, listUpdates, resetData, revertUpdate } from "../data/api.js";
import { WEEKLY_BUDGET } from "../data/demo.js";
import { load, store } from "../state.js";
import { pageHead } from "../ui/kit.js";
import { toast } from "../ui/overlay.js";

export function mountSettings(root: HTMLElement) {
  document.title = "Settings & Integrations · StockPulse AMD";
  let updates: import("../data/types.js").ConfirmedUpdate[] | null = null;
  let ds: import("../data/types.js").DataStatus | null = null;

  async function fetchAll() {
    try { [updates, ds] = await Promise.all([listUpdates(true).then((r) => r.updates), dataStatus()]); } catch { updates = updates || []; }
    render();
  }

  function render() {
    const s = store.get();
    const d = s.data;
    const h = s.health;
    const name = (u: import("../data/types.js").ConfirmedUpdate) => (u.sku ? d?.products.find((p) => p.sku === u.sku)?.name || u.sku : d?.suppliers.find((x) => x.supplier_id === u.supplier_id)?.name || u.supplier_id);
    setHTML(root, html`
      ${pageHead({ title: "Settings & Integrations", sub: "What the calculations use, where the data comes from, and what is connected." })}
      <div class="settings-grid">
        <section class="panel" aria-labelledby="pol-title">
          <div class="panel-head"><div><h2 class="panel-title" id="pol-title">Purchasing policy</h2><p class="panel-sub">The budget is yours to set. Service level and review period are engine policy, set in <code>.env</code>.</p></div></div>
          <div class="panel-body form-grid">
            <div class="field"><label for="set-budget">Weekly purchasing budget (USD)</label>
              <span class="input-prefix"><span>$</span><input class="input num" id="set-budget" type="number" min="0" step="100" value="${s.settings.budget}"></span>
              <small class="muted">Used by the optimizer, cart, Risk Radar and Overview. Default ${money(WEEKLY_BUDGET)}.</small></div>
            <dl class="kv">
              <div><dt>Service level</dt><dd>${d ? pct(d.policy.service_level, 0) : "-"} <span class="muted">SERVICE_LEVEL</span></dd></div>
              <div><dt>Review period</dt><dd>${d ? `${d.policy.review_days} days` : "-"} <span class="muted">REVIEW_DAYS</span></dd></div>
              <div><dt>Excess stock threshold</dt><dd>${d ? `${int(d.policy.excess_cover_days)} days of cover` : "-"} <span class="muted">EXCESS_COVER_DAYS</span></dd></div>
              <div><dt>Storage limits</dt><dd class="muted">Not on file, so not applied</dd></div>
            </dl>
          </div>
        </section>

        <section class="panel" aria-labelledby="data-title">
          <div class="panel-head"><div><h2 class="panel-title" id="data-title">Data source</h2><p class="panel-sub">Sales, inventory and supplier tables the engine reads.</p></div></div>
          <div class="panel-body">
            <dl class="kv">
              <div><dt>Active dataset</dt><dd>${ds ? (ds.source === "sample" ? "Bundled sample (synthetic)" : "Imported CSVs") : "-"}</dd></div>
              <div><dt>Coverage</dt><dd>${ds ? `${int(ds.skus)} SKUs · ${int(ds.suppliers)} suppliers · ${int(ds.history_days)} days of sales` : "-"}</dd></div>
              <div><dt>Sales through</dt><dd>${d ? shortDate(new Date(new Date(d.as_of).getTime() - 864e5)) : "-"}</dd></div>
            </dl>
            <div class="row-actions" style="margin-top:12px">
              <button class="btn btn-secondary" type="button" data-action="import">${icon("upload", "icon-sm")}Import CSVs</button>
              ${ds?.source === "imported" ? html`<button class="btn btn-ghost" type="button" data-reset-data>Switch back to sample data</button>` : ""}
            </div>
          </div>
        </section>

        <section class="panel span-2" aria-labelledby="upd-title">
          <div class="panel-head"><div><h2 class="panel-title" id="upd-title">Confirmed supplier updates</h2><p class="panel-sub">Values confirmed in the Supplier Inbox. They override the CSV values in every calculation until reverted.</p></div></div>
          ${updates == null ? html`<div class="panel-body"><div class="skeleton sk-line" style="width:60%"></div></div>`
            : updates.length ? html`<div class="table-wrap"><table class="ptable" style="min-width:720px">
              <thead><tr><th scope="col">Applies to</th><th scope="col">Field</th><th scope="col" class="r">Was</th><th scope="col" class="r">Now</th><th scope="col">Source</th><th scope="col">Confirmed</th><th scope="col"></th></tr></thead>
              <tbody>${updates.map((u) => html`<tr style="cursor:default" class="${u.reverted_at ? "is-reverted" : ""}">
                <td>${name(u)}${u.sku ? html` <span class="mono muted">${u.sku}</span>` : ""}</td><td>${u.field.replace(/_/g, " ")}</td>
                <td class="r num">${u.old_value == null ? "-" : u.field === "unit_cost" ? cents(u.old_value) : int(u.old_value)}</td>
                <td class="r num"><b>${u.field === "unit_cost" ? cents(u.new_value) : int(u.new_value)}</b></td>
                <td><span class="cell-sub" style="font-size:var(--fs-xs)">${u.source_doc || "-"}${u.source_ref ? ` · ${u.source_ref}` : ""}</span></td>
                <td class="num">${shortDate(new Date(u.confirmed_at))} · ${u.confirmed_by}</td>
                <td class="r">${u.reverted_at ? html`<span class="muted">Reverted</span>` : html`<button class="btn btn-sm btn-ghost" type="button" data-revert="${u.id}">Revert</button>`}</td></tr>`)}</tbody></table></div>`
            : html`<p class="panel-body muted">None yet. Confirm a document in the <a href="#/inbox">Supplier Inbox</a> to see it here.</p>`}
        </section>

        <section class="panel span-2" aria-labelledby="int-title">
          <div class="panel-head"><div><h2 class="panel-title" id="int-title">Integrations</h2><p class="panel-sub">Status as reported by the running engine. Nothing here is simulated.</p></div></div>
          <ul class="integrations">
            ${integration("Language model", h?.llm_enabled ? `Connected: ${h.model}` : "Not configured", h?.llm_enabled ? "healthy" : "excess",
              h?.llm_enabled ? "Rephrases assistant answers from calculated facts and runs the agent's tool-calling loop. It never produces quantities, costs or risk scores." : "Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (AMD Token Factory, OpenAI-compatible). Until then the assistant and agent run deterministically.")}
            ${integration("Document extraction (multimodal, AMD Instinct + ROCm)", "Not connected", "excess", "Planned. Sample documents use simulated extraction; your files are reviewed by hand.")}
            ${integration("REST tool API", "Available", "healthy", html`Every tool is callable at <code>POST /api/tools/{name}</code>. See <a href="/docs">API reference</a>.`)}
            ${integration("MCP server", "Not built", "excess", "Planned: expose the same tool registry over MCP.")}
            ${integration("Supplier dispatch (email / EDI / Evolus)", "Not connected", "excess", "Approved orders are sent by you; the app records it. Use the email shortcut on an approved order.")}
          </ul>
        </section>
      </div>`);
  }

  const integration = (name: string, st: string, level: string, body: unknown) => html`<li><div><b>${name}</b><p class="muted">${body}</p></div><span class="status status-${level}">${st}</span></li>`;

  on(root, "change", "#set-budget", (_e, t) => {
    const v = Math.round(Number((t as HTMLInputElement).value));
    if (!Number.isFinite(v) || v < 0) { toast("Budget must be zero or more"); render(); return; }
    store.set({ settings: { ...store.get().settings, budget: v } });
    toast(`Weekly budget set to ${money(v)}`);
  });
  on(root, "click", "[data-revert]", async (_e, t) => {
    try { await revertUpdate(Number(t.dataset.revert)); await load(); toast("Reverted"); fetchAll(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  });
  on(root, "click", "[data-reset-data]", async () => {
    try { await resetData(); await load(); toast("Switched back to the bundled sample data"); fetchAll(); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  });

  render();
  fetchAll();
  const unsub = store.subscribe((_s, ch) => { if (ch.has("data")) fetchAll(); else if (ch.has("health") || ch.has("settings")) render(); });
  return () => unsub();
}
