/**
 * Procurement assistant panel. A side sheet that supports the current decision; it doesn't block
 * the page. Answers come from /api/assistant, which computes them deterministically and lists the
 * functions it ran; a language model may only rephrase them (marked when it does).
 */
import { $, html, on, setHTML } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { ask } from "../data/api.js";
import { go, store } from "../state.js";
import { prov } from "./status.js";
import { surfaceIn, surfaceItemIn } from "../lib/motion.js";

interface ThreadItem { q: string; sku: string | null; a?: import("../data/types.js").AssistantAnswer; err?: string; pending?: boolean }
const thread: ThreadItem[] = [];
let root = (null as HTMLElement | null);
let returnTo = (null as Element | null);

const SOURCE_LABEL = { calc: "Calculated", forecast: "Forecast", extracted: "Extracted" };

export function mountAssistant() {
  root = document.createElement("aside");
  root.className = "assistant";
  root.setAttribute("aria-labelledby", "as-title");
  root.hidden = true;
  document.body.append(root);

  on(root, "click", "[data-as-close]", () => store.set({ assistant: { ...store.get().assistant, open: false } }));
  on(root, "click", "[data-as-suggest]", (_e, t) => send((t.dataset.asSuggest as string)));
  on(root, "submit", "form", (e) => {
    e.preventDefault();
    const input = (($("#as-input", (root as HTMLElement))) as HTMLInputElement);
    if (input.value.trim()) send(input.value.trim());
  });
  on(root, "click", "[data-as-link]", (_e, t) => {
    const kind = t.dataset.asLink, id = t.dataset.id || "";
    if (kind === "sku") store.set({ drawer: { type: "sku", sku: id } });
    else if (kind === "cart_line") go(`cart?sku=${id}`);
    else if (kind === "cart") go("cart");
  });
  on(root, "click", "[data-as-clear]", () => { thread.length = 0; paint(); });
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") store.set({ assistant: { ...store.get().assistant, open: false } }); });

  store.subscribe((s, ch) => {
    if (!ch.has("assistant")) return;
    const r = (root as HTMLElement);
    if (s.assistant.open && r.hidden) {
      returnTo = document.activeElement;
      r.hidden = false;
      paint();
      surfaceIn(r);
      (($("#as-input", r)) as HTMLElement | null)?.focus();
      if (s.assistant.seed) send(s.assistant.seed);
    } else if (!s.assistant.open && !r.hidden) {
      r.hidden = true;
      if (returnTo instanceof HTMLElement && document.contains(returnTo)) returnTo.focus();
    } else if (s.assistant.open && s.assistant.seed) {
      send(s.assistant.seed);
    }
  });
}

async function send(q: string) {
  const s = store.get();
  const sku = s.assistant.sku;
  if (s.assistant.seed) store.set({ assistant: { ...s.assistant, seed: "" } });
  const item: ThreadItem = { q, sku, pending: true };
  thread.push(item);
  paint();
  try {
    item.a = await ask({ question: q, sku, budget: s.settings.budget });
  } catch (e) {
    item.err = e instanceof Error ? e.message : String(e);
  }
  item.pending = false;
  paint();
  const answers = root?.querySelectorAll(".as-a");
  if (answers?.length) surfaceItemIn(answers[answers.length - 1]);
}

function paint() {
  if (!root) return;
  const s = store.get();
  const p = s.assistant.sku && s.data ? s.data.products.find((x) => x.sku === s.assistant.sku) : null;
  const sup = s.data?.suppliers.find((x) => x.supplier_id === (p?.supplier_id || "S5"))?.name || "a supplier";
  const suggestions = [
    p ? `Why is ${p.name} at risk?` : "Why is Peanuts 200g at risk?",
    p ? `Why this reorder quantity for ${p.name}?` : "Why this reorder quantity for Hand Soap 250ml?",
    "What happens if my weekly budget decreases by 15%?",
    `What happens if ${sup} adds 5 days to the lead time?`,
    "Which products can be prioritized within the current budget?",
  ];
  const llm = s.health?.llm_enabled;
  setHTML(root, html`
    <header class="as-head">
      <div><h2 id="as-title">Procurement assistant</h2>
        <p class="muted">${p ? html`About <b>${p.name}</b> · ` : ""}answers from the engine's numbers</p></div>
      <button class="btn btn-icon" type="button" data-as-close aria-label="Close assistant">${icon("x")}</button>
    </header>
    <div class="as-mode">${llm ? html`${prov("ai")}<span>Wording by ${s.health?.model} on AMD; every number is calculated first and checked.</span>`
      : html`<span class="prov prov-sample">Simulated assistant</span><span>No language model is configured, so answers are built from templates over real calculations.</span>`}</div>
    <div class="as-body" aria-live="polite">
      ${thread.length ? thread.map((t) => html`<div class="as-q">${t.q}</div>
        ${t.pending ? html`<div class="as-a"><span class="muted">Calculating…</span></div>`
        : t.err ? html`<div class="as-a"><p class="txt-critical">${t.err}</p></div>`
        : t.a ? html`<div class="as-a">
          <div class="as-text">${t.a.answer.split("\n").map((line) => html`<p>${line}</p>`)}</div>
          ${t.a.facts.length ? html`<dl class="as-facts">${t.a.facts.map((f) => html`<div><dt>${f.label}<span class="prov prov-${f.source === "extracted" ? "ai" : "calc"}">${SOURCE_LABEL[f.source]}</span></dt><dd class="num">${f.value}</dd></div>`)}</dl>` : ""}
          ${t.a.links.length ? html`<div class="as-links">${t.a.links.map((l) => html`<button class="btn btn-sm btn-secondary" type="button" data-as-link="${l.kind}" data-id="${l.id}">${l.label}${icon("arrowRight", "icon-xs")}</button>`)}</div>` : ""}
          <p class="as-meta">${t.a.mode === "llm" ? html`${prov("ai")} Reworded by ${t.a.model}` : html`<span class="prov prov-calc">Deterministic answer</span>`}
            ${t.a.tools_run.length ? html` · ran ${t.a.tools_run.join(", ")}` : " · no calculation needed"}${t.a.note ? html` · ${t.a.note}` : ""}</p>
        </div>` : ""}`)
      : html`<div class="as-empty"><p>Ask about a SKU, the budget or a supplier delay. Try:</p></div>`}
      <div class="as-suggest">${suggestions.map((q) => html`<button class="btn btn-sm btn-secondary" type="button" data-as-suggest="${q}">${q}</button>`)}</div>
    </div>
    <form class="as-form">
      <label class="visually-hidden" for="as-input">Ask a question</label>
      <input class="input" id="as-input" type="text" autocomplete="off" placeholder="Ask about a product, the budget or a supplier">
      <button class="btn btn-primary" type="submit">Ask</button>
    </form>
    ${thread.length ? html`<button class="btn btn-link btn-sm as-clear" type="button" data-as-clear>Clear conversation</button>` : ""}`);
  const body = $(".as-body", root);
  if (body) body.scrollTop = body.scrollHeight;
}
