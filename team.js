// "My team": what a manager may see of the people who report to them (directly or through others): who they are, their position and who
// each reports to. Nothing about their business: a manager enters their own sales and knows who is under them, never what those people sold,
// what they hold, or anything about their pay.
const svc = require("./service");

async function overview(db, user, period) {
  svc.assertPeriod(period);
  const ids = (user.teamIds || []).filter((id) => id !== user.employee_id);
  const people = ids.length ? await db.all(`SELECT employee_id, name, staff_level, hub, upline_id FROM staff WHERE employee_id = ANY(?::text[]) AND status = 'active' ORDER BY name`, ids) : [];
  const byId = new Map(people.map((p) => [p.employee_id, p]));
  const kids = new Map();
  for (const p of people) { const up = byId.has(p.upline_id) ? p.upline_id : user.employee_id; (kids.get(up) || kids.set(up, []).get(up)).push(p); }
  // In reporting order: each person, then the people under them, indented one step more.
  const members = [];
  const walk = (id, depth) => { for (const k of kids.get(id) || []) { if (depth < 8) { members.push({ employee_id: k.employee_id, name: k.name, staff_level: k.staff_level, hub: k.hub,
    reports_to: k.upline_id && k.upline_id !== user.employee_id ? byId.get(k.upline_id)?.name || null : null, depth }); walk(k.employee_id, depth + 1); } } };
  walk(user.employee_id, 1);
  return { period, me: { employee_id: user.employee_id, name: user.full_name }, members, totals: { people: members.length } };
}

module.exports = { overview };
