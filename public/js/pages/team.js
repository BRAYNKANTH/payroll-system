// My team: the page a manager lands on. It shows who is under them (directly or through others) and their position.
// Nothing about what those people sold, hold or earn: a manager enters their own sales on My page and knows who is under them.
import { get, qs } from "../api.js";
import { state, can } from "../app.js";
import { $, html, icon, initials, levelLabel, emptyState } from "../ui.js";

export default {
  title: "My team",
  filters: false, // nothing here depends on the hub or the month
  async render({ el }) {
    const d = await get("/api/team" + qs({ period: state.period }));
    const first = (state.user.full_name || "").split(" ")[0];
    const keeper = can("stock");
    const levels = Object.entries(d.members.reduce((m, p) => ({ ...m, [p.staff_level]: (m[p.staff_level] || 0) + 1 }), {}));

    el.innerHTML = html`
      <div class="page-head">
        <div><h1>My team</h1><p>The people who report to you${d.members.length ? `: ${levels.map(([l, n]) => `${n} ${levelLabel(l, n).toLowerCase()}`).join(" · ")}` : ""}. Enter your own sales on My page.</p></div>
        <div class="actions"><a class="btn primary" href="/me" data-link>${icon("trend")} My page</a></div>
      </div>
      ${keeper ? html`<div class="alert info mb-4">${icon("box")}<div><b>You are a stock keeper.</b> You can give stock to everyone in the hub, not only your own people. <a class="btn sm" href="/morning" data-link>Open Give stock</a></div></div>` : ""}
      <section aria-label="Your people">
        ${d.members.length ? html`<div class="card hs-list"><ul role="list">${d.members.map((m) => html`<li><a class="hs-row" href="/employees/${encodeURIComponent(m.employee_id)}" data-link aria-label="${m.name}: open record" style="padding-left:${16 + (m.depth - 1) * 18}px">
          <span class="avatar" aria-hidden="true">${initials(m.name)}</span>
          <span class="hs-main"><b>${m.name}</b><span class="muted">${m.employee_id} · ${levelLabel(m.staff_level)}${m.reports_to ? ` · reports to ${m.reports_to}` : ""}</span></span>
          <span class="hs-chev" aria-hidden="true"></span></a></li>`)}</ul></div>`
          : html`<div class="card">${emptyState("No one reports to you yet", `${first ? first + ", " : ""}people you are the manager of appear here.`, "users")}</div>`}
      </section>`;
  },
};
