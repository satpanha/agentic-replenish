/** E: risk and supplier insights. F: latest operational activity. */
import { html } from "../../lib/dom.js";
import { clock, shortDate } from "../../lib/format.js";
import { activity, insights, pendingUpdates } from "../../data/model.js";
import { prov, severityIcon } from "../../ui/status.js";

const SEV_LABEL = { critical: "Critical", warning: "Warning", info: "Watch" };

export function insightsPanel(d: import("../../data/types.js").Dashboard, pending: ReturnType<typeof pendingUpdates>) {
  const list = insights(d, pending);
  const crit = list.filter((i) => i.severity === "critical").length;
  return html`
    <div class="panel-head">
      <div>
        <h2 class="panel-title" id="ins-title">Risk and supplier insights</h2>
        <p class="panel-sub">${crit ? `${crit} urgent, ${list.length - crit} to review` : `${list.length} to review`}</p>
      </div>
    </div>
    <ul class="insights" aria-labelledby="ins-title">
      ${list.map((i) => html`
        <li class="insight sev-${i.severity}" data-id="${i.id}">
          <span class="insight-icon" aria-hidden="true">${severityIcon(i.severity)}</span>
          <div class="insight-body">
            <div class="insight-top"><span><span class="insight-sev">${SEV_LABEL[i.severity]}</span> · ${i.subject}</span>${prov(i.source)}</div>
            <h3>${i.title}</h3>
            <p>${i.body}</p>
            <div class="insight-actions">
              <p class="insight-impact"><b>Impact:</b> ${i.impact}</p>
              <button class="btn btn-sm btn-secondary" type="button" data-action="${i.cta.action}" data-arg="${i.cta.arg || ""}">${i.cta.label}</button>
            </div>
          </div>
        </li>`)}
    </ul>`;
}

export function activityPanel(d: import("../../data/types.js").Dashboard, docs: import("../../data/types.js").InboxDoc[], budget: number) {
  const items = activity(d, docs, budget);
  const today = d.as_of;
  return html`
    <div class="panel-head">
      <div>
        <h2 class="panel-title" id="act-title">Latest activity</h2>
        <p class="panel-sub">Engine events use the demo session clock; document times come from the inbox. Counts come from the current engine run.</p>
      </div>
      <span class="tag-demo">Sample</span>
    </div>
    <ol class="activity" aria-labelledby="act-title" reversed>
      ${items.map((a) => html`
        <li class="act act-${a.kind}">
          <time class="num" datetime="${a.at}">${(a.at || "").slice(0, 10) === today ? clock(new Date(a.at || 0)) : shortDate(new Date(a.at || 0))}</time>
          <span class="act-mark" aria-hidden="true"></span>
          <span class="act-text">${a.text}${a.detail ? html` <span>· ${a.detail}</span>` : ""}</span>
          ${a.kind === "ai" ? prov("ai") : a.kind === "calc" || a.kind === "risk" ? prov("calc") : html`<span class="prov prov-sample">System</span>`}
        </li>`)}
    </ol>`;
}
