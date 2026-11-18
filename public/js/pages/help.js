import { state, isStaff } from "../app.js";
import { html, raw, icon, esc } from "../ui.js";
import { GLOSSARY } from "./portal.js";

// One Help page, reachable from the account menu on every screen (same place for everyone).
export default {
  title: "Help",
  async render({ el }) {
    const staff = isStaff();
    const tips = staff
      ? [["See my numbers", "Open My page. The tabs along the bottom show Sell, This month, Payslips and more."],
         ["Come back to a section", "Each tab has its own address, so the Back button moves between tabs."],
         ["Refresh", "Use the Refresh button, or pull the page down, to get the latest figures."]]
      : [["Find a person or a hub", "Press / (or Ctrl+K) to jump to the search box. Pick a result to open it. Your recent picks show when the box is empty."],
         ["Change the month", "Use the month picker at the top. Every page shows that month."],
         ["Share or come back to a filtered list", "Search and filter choices are kept in the address, so Back, bookmarks and shared links show the same list."],
         ["Undo a mistake", "Sheets warn you before you leave with unsaved changes. Forms ask before they throw away what you typed."]];
    el.innerHTML = html`
      <div class="page-head"><div><h1>Help</h1><p>Getting around, and what the words mean.</p></div></div>
      <div class="card"><div class="card-head"><h2>Getting around</h2></div><div class="card-body"><dl class="glossary">${raw(tips.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join(""))}</dl></div></div>
      <div class="card"><div class="card-head"><h2>What do these words mean?</h2></div><div class="card-body"><dl class="glossary">${raw(GLOSSARY.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join(""))}</dl></div></div>
      <div class="card"><div class="card-head"><h2>Need a hand?</h2></div><div class="card-body"><p style="margin:0">${icon("info")} Ask your hub coacher or manager. If you cannot sign in, ask the office to set a new password for you${state.settings?.company_name ? ` (${esc(state.settings.company_name)})` : ""}.</p></div></div>`;
  },
};
