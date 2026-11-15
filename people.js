// People who leave and people who join again.
//
// A person is never deleted: leaving sets them inactive with a leave date and a reason, and their history stays. If other people
// report to them, those people move to a replacement who holds the same position (a new coacher for a branch, a new manager, ...).
// Someone who comes back is re-hired: active again with a new join date. A brand-new person is simply added as an employee.
const { withUser, httpError } = require("./db");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOW = "now_iso()";
const MANAGER_LEVELS = new Set(["manager", "promoting_manager", "coacher"]);

function checkDate(name, raw) {
  if (!DATE_RE.test(String(raw || "")) || isNaN(Date.parse(raw))) throw httpError(400, `${name} must be YYYY-MM-DD`);
  return raw;
}

// A hub-limited user (a hub manager) may only handle people of their own hub, and never a manager-level person.
async function load(db, id, scopeHub) {
  const s = await db.get("SELECT * FROM staff WHERE employee_id = ?", id);
  if (!s) throw httpError(404, "Employee not found");
  if (scopeHub && (s.hub !== scopeHub || MANAGER_LEVELS.has(s.staff_level))) throw httpError(403, "Hub users cannot change managers or other hubs");
  return s;
}

async function leave(db, id, body, user, scopeHub) {
  const s = await load(db, id, scopeHub);
  if (s.status !== "active") throw httpError(409, `${s.name} has already left`);
  const leaveDate = checkDate("leave_date", body.leave_date);
  const reason = String(body.reason || "").trim().slice(0, 200) || null;

  const reports = await db.all("SELECT employee_id FROM staff WHERE status = 'active' AND (upline_id = ? OR manager_id = ?)", id, id);
  let replacement = null;
  if (reports.length) {
    if (!body.replacement_id) throw httpError(400, `${reports.length} ${reports.length === 1 ? "person reports" : "people report"} to ${s.name}. Choose who they move to`);
    replacement = await db.get("SELECT * FROM staff WHERE employee_id = ?", String(body.replacement_id));
    if (!replacement || replacement.status !== "active" || replacement.employee_id === id) throw httpError(400, "Choose an active person as the replacement");
    if (replacement.staff_level !== s.staff_level) throw httpError(400, `The replacement must also be a ${s.staff_level.replace("_", " ")}`);
    if (replacement.hub !== s.hub) throw httpError(400, "The replacement must be in the same hub");
  }
  await withUser(db, user, async (t) => {
    if (replacement) {
      await t.run("UPDATE staff SET upline_id = ?, updated_by = ?, updated_at = " + NOW + " WHERE upline_id = ? AND status = 'active'", replacement.employee_id, user, id);
      await t.run("UPDATE staff SET manager_id = ?, updated_by = ?, updated_at = " + NOW + " WHERE manager_id = ? AND status = 'active'", replacement.employee_id, user, id);
    }
    await t.run("UPDATE staff SET status = 'inactive', leave_date = ?, leave_reason = ?, updated_by = ?, updated_at = " + NOW + " WHERE employee_id = ?", leaveDate, reason, user, id);
  });
  return { employee_id: id, left_on: leaveDate, moved: replacement ? reports.length : 0, replacement: replacement?.employee_id || null };
}

async function rehire(db, id, body, user, scopeHub) {
  const s = await load(db, id, scopeHub);
  if (s.status === "active") throw httpError(409, `${s.name} is already active`);
  const joinDate = checkDate("join_date", body.join_date);
  if (s.leave_date && joinDate < s.leave_date) throw httpError(400, `The new join date is before they left (${s.leave_date})`);
  // Their old upline may have left meanwhile: the person must report to someone who is still here.
  if (s.upline_id) {
    const up = await db.get("SELECT status FROM staff WHERE employee_id = ?", s.upline_id);
    if (!up || up.status !== "active") throw httpError(400, "The person they used to report to has left. Edit their record to choose a new person to report to, then re-hire");
  }
  await withUser(db, user, (t) => t.run("UPDATE staff SET status = 'active', join_date = ?, leave_date = NULL, leave_reason = NULL, updated_by = ?, updated_at = " + NOW + " WHERE employee_id = ?", joinDate, user, id));
  return { employee_id: id, joined_on: joinDate };
}

module.exports = { leave, rehire };
