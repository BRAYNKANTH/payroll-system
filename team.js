// "My team": what a manager may see of the people who report to them (directly or through others): their sales, today's sales, the stock they
// hold and the days waiting to be confirmed. Sales and stock only, never anyone's pay.
const svc = require("./service");
const sales = require("./sales");

const num = (v) => Number(v) || 0;
const monthBounds = (period) => [period + "-01", svc.shiftPeriod(period, 1) + "-01"];

async function overview(db, user, period) {
  svc.assertPeriod(period);
  const ids = (user.teamIds || []).filter((id) => id !== user.employee_id);
  const today = sales.today();
  const [from, to] = monthBounds(period);
  const people = ids.length ? await db.all(`SELECT employee_id, name, staff_level, role, hub, upline_id, status FROM staff WHERE employee_id = ANY(?::text[]) AND status = 'active' ORDER BY name`, ids) : [];
  const keys = people.map((p) => p.employee_id);
  const month = keys.length ? await db.all(`SELECT employee_id, COALESCE(SUM(business_amount), 0) AS business, COUNT(*) AS days,
      COUNT(*) FILTER (WHERE source = 'portal' AND confirmed_by IS NULL) AS unconfirmed
    FROM daily_log WHERE date >= ? AND date < ? AND employee_id = ANY(?::text[]) GROUP BY employee_id`, from, to, keys) : [];
  const day = keys.length ? await db.all("SELECT employee_id, business_amount FROM daily_log WHERE date = ? AND employee_id = ANY(?::text[])", today, keys) : [];
  const given = keys.length ? await db.all("SELECT employee_id, SUM(qty) AS n FROM stock_issues WHERE date <= ? AND employee_id = ANY(?::text[]) GROUP BY employee_id", today, keys) : [];
  const sold = keys.length ? await db.all("SELECT employee_id, SUM(qty) AS n FROM sale_lines WHERE date <= ? AND employee_id = ANY(?::text[]) GROUP BY employee_id", today, keys) : [];
  const by = (rows, f) => new Map(rows.map((r) => [r.employee_id, f(r)]));
  const mo = by(month, (r) => r), dy = by(day, (r) => num(r.business_amount)), gv = by(given, (r) => num(r.n)), sd = by(sold, (r) => num(r.n));
  const members = people.map((p) => ({
    employee_id: p.employee_id, name: p.name, staff_level: p.staff_level, hub: p.hub, upline_id: p.upline_id,
    month_business: num(mo.get(p.employee_id)?.business), month_days: num(mo.get(p.employee_id)?.days), unconfirmed: num(mo.get(p.employee_id)?.unconfirmed),
    today_business: dy.get(p.employee_id) || 0, stock_pieces: Math.max(0, (gv.get(p.employee_id) || 0) - (sd.get(p.employee_id) || 0)),
  }));
  return {
    period, today, me: { employee_id: user.employee_id, name: user.full_name },
    members,
    totals: {
      people: members.length,
      month_business: members.reduce((t, m) => t + m.month_business, 0),
      today_business: members.reduce((t, m) => t + m.today_business, 0),
      unconfirmed: members.reduce((t, m) => t + m.unconfirmed, 0),
      stock_pieces: members.reduce((t, m) => t + m.stock_pieces, 0),
    },
  };
}

module.exports = { overview };
