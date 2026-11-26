// Which team a person belongs to. A team is a manager (or a promoting manager, who is also a manager of his own sellers) and everyone under them,
// so a hub is a handful of teams. Used by the live sales view and by morning stock, so both group people the same way.

const leadsATeam = (x) => x && (x.staff_level === "manager" || x.staff_level === "promoting_manager");

// The nearest manager above a person (or themselves, for a manager); else whoever they report to; else nobody.
function teamOf(person, byId) {
  let boss = leadsATeam(person) ? person : null, cur = person, hops = 0;
  while (!boss && cur?.upline_id && hops++ < 8) { cur = byId.get(cur.upline_id); if (leadsATeam(cur)) boss = cur; }
  if (boss) return { id: boss.employee_id, title: boss.name, sub: `${boss.staff_level === "promoting_manager" ? "Promoting manager" : "Manager"} · ${boss.employee_id}`, order: 0 };
  const up = byId.get(person.upline_id);
  return up ? { id: "up:" + up.employee_id, title: `Team of ${up.name}`, sub: up.employee_id, order: 1 } : { id: "none", title: "No manager", sub: "", order: 2 };
}

// Someone who sells, or leads a team that sells: the people that appear on the sales and stock screens.
const sellersWhere = "s.status = 'active' AND (s.role = 'guy' OR s.staff_level IN ('manager', 'promoting_manager'))";

module.exports = { teamOf, sellersWhere };
