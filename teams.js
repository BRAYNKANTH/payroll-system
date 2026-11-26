// Which team a person belongs to. A team is a manager and everyone under them, so a hub is a handful of teams.
// Used by the live sales view and by morning stock, so both group people the same way.

// The manager above a person (or themselves, for a manager); else whoever they report to; else nobody.
function teamOf(person, byId) {
  const isManager = (x) => x && x.staff_level === "manager";
  let boss = isManager(person) ? person : null, cur = person, hops = 0;
  while (!boss && cur?.upline_id && hops++ < 8) { cur = byId.get(cur.upline_id); if (isManager(cur)) boss = cur; }
  if (boss) return { id: boss.employee_id, title: boss.name, sub: `Manager · ${boss.employee_id}`, order: 0 };
  const up = byId.get(person.upline_id);
  return up ? { id: "up:" + up.employee_id, title: `Reports to ${up.name}`, sub: up.employee_id, order: 1 } : { id: "none", title: "No manager", sub: "", order: 2 };
}

// Someone who sells, or leads a team that sells: the people that appear on the sales and stock screens.
const sellersWhere = "s.status = 'active' AND (s.role = 'guy' OR s.staff_level = 'manager')";

module.exports = { teamOf, sellersWhere };
