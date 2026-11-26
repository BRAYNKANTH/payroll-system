// "Team sales": what a manager or promoting manager may see about the people who report to them (directly or through others): how much business
// the team did, in total, today and this month. No names, no positions, no one's own figures, no pay. The manager's own selling is on the Sell page,
// and nobody above them (their own manager) is ever shown.
const svc = require("./service");
const sales = require("./sales");

const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];

async function overview(db, user, period) {
  svc.assertPeriod(period);
  const ids = (user.teamIds || []).filter((id) => id !== user.employee_id);
  const today = sales.today();
  const sum = async (from, to) => ids.length
    ? Number((await db.get("SELECT COALESCE(SUM(business_amount), 0) AS t FROM daily_log WHERE employee_id = ANY(?::text[]) AND date >= ? AND date < ?", ids, from, to)).t) || 0 : 0;
  const nextDay = new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const [from, to] = monthBounds(period);
  // Each day of the month, newest first, so the manager can see how the team is doing day by day (totals only).
  const days = ids.length ? (await db.all("SELECT date, COALESCE(SUM(business_amount), 0) AS business FROM daily_log WHERE employee_id = ANY(?::text[]) AND date >= ? AND date < ? GROUP BY date HAVING SUM(business_amount) > 0 ORDER BY date DESC", ids, from, to))
    .map((r) => ({ date: r.date, business: Number(r.business) })) : [];
  return { period, date: today, business: { today: await sum(today, nextDay), month: await sum(from, to) }, days };
}

module.exports = { overview };
