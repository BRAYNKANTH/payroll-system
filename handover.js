// Cash handover: each day a hub's coacher hands the day's cash to the office (the admin). It must be at least 90% of the hub's sales for that day.
// The coacher opens the handover, types the amount and submits it. The admin checks it against the cash received and approves it, or sends it
// back with a reason (the coacher can then correct it and submit again). An approved handover is final.
const { withUser, httpError } = require("./db");
const sales = require("./sales");

const MIN_SHARE = 0.9; // at least this share of the day's sales must be handed over
const DAYS_BACK = 7;   // how far back a handover can still be made
const NOW = "now_iso()";

const minimum = (cents) => Math.ceil(cents * MIN_SHARE);
const rs = (cents) => (Number(cents) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (row) => ({ ...row, id: Number(row.id), sales: Number(row.sales), amount: Number(row.amount) });

function checkDate(raw) {
  const date = String(raw || sales.today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw httpError(400, "date must be YYYY-MM-DD");
  return date;
}

// What a hub sold on a day (the total of its daily sheet).
async function salesOf(db, hub, date) {
  const r = await db.get("SELECT COALESCE(SUM(d.business_amount), 0) AS s FROM daily_log d JOIN staff s USING (employee_id) WHERE d.date = ? AND s.hub = ?", date, hub);
  return Number(r.s);
}

// One day, hub by hub: the sales, the least that must be handed over, and the handover (if any). A hub-limited user gets only their own hub.
async function day(db, { date, hub }) {
  const d = checkDate(date);
  const hubs = await db.all(`SELECT code, name FROM hubs WHERE status = 'active'${hub ? " AND code = ?" : ""} ORDER BY code`, ...(hub ? [hub] : []));
  const sold = new Map((await db.all("SELECT s.hub, COALESCE(SUM(d.business_amount), 0) AS s FROM daily_log d JOIN staff s USING (employee_id) WHERE d.date = ? GROUP BY s.hub", d)).map((r) => [r.hub, Number(r.s)]));
  const done = new Map((await db.all("SELECT * FROM cash_handovers WHERE date = ?", d)).map((r) => [r.hub, num(r)]));
  // The cash the sellers actually handed in that day (the daily sheet's "settled"), so the coacher can see what is in hand.
  const cash = new Map((await db.all("SELECT s.hub, COALESCE(SUM(d.settled_amount), 0) AS c FROM daily_log d JOIN staff s USING (employee_id) WHERE d.date = ? GROUP BY s.hub", d)).map((r) => [r.hub, Number(r.c)]));
  return {
    date: d, min_percent: Math.round(MIN_SHARE * 100),
    hubs: hubs.map((h) => { const s = sold.get(h.code) || 0; return { code: h.code, name: h.name, sales: s, min: minimum(s), cash: cash.get(h.code) || 0, handover: done.get(h.code) || null }; }),
  };
}

// Handovers, newest first. Each carries the hub's sales for its day as they are now, so a change to the daily sheet after the handover shows.
async function list(db, { hub, status, limit }) {
  const where = [], args = [];
  if (hub) { where.push("c.hub = ?"); args.push(hub); }
  if (status) { where.push("c.status = ?"); args.push(status); }
  const rows = await db.all(`SELECT c.*, h.name AS hub_name FROM cash_handovers c JOIN hubs h ON h.code = c.hub${where.length ? " WHERE " + where.join(" AND ") : ""}
    ORDER BY c.date DESC, c.id DESC LIMIT ?`, ...args, Math.min(Number(limit) || 30, 100));
  return Promise.all(rows.map(async (r) => {
    const now = await salesOf(db, r.hub, r.date);
    return { ...num(r), sales_now: now, min_now: minimum(now), short: Number(r.amount) < minimum(now) };
  }));
}

// The coacher hands over the day's cash. Only a hub-limited login (a coacher) can; the office never submits for a hub.
async function submit(db, user, body) {
  const hub = user.hub;
  if (!hub) throw httpError(403, "Only a hub's coacher hands cash over. The office checks it");
  const date = checkDate(body.date);
  const now = sales.today();
  if (date > now) throw httpError(400, "You cannot hand over cash for a day that has not happened yet");
  if (date < sales.addDays(now, -DAYS_BACK)) throw httpError(400, `A handover can be made up to ${DAYS_BACK} days back`);
  const amount = sales.rupees("Amount", body.amount);
  if (amount <= 0) throw httpError(400, "Enter the amount you are handing over");
  const note = String(body.note || "").trim().slice(0, 200) || null;
  return withUser(db, user.username, async (t) => {
    const s = await salesOf(t, hub, date);
    if (s <= 0) throw httpError(400, "No sales are entered for that day yet. Enter the day on the daily sheet first");
    const min = minimum(s);
    if (amount < min) throw httpError(400, `Hand over at least Rs ${rs(min)}, which is ${Math.round(MIN_SHARE * 100)}% of the day's sales of Rs ${rs(s)}`);
    const had = await t.get("SELECT id, status FROM cash_handovers WHERE hub = ? AND date = ?", hub, date);
    if (had?.status === "approved") throw httpError(409, "The office has already approved this day's handover");
    const row = had
      ? await t.get(`UPDATE cash_handovers SET sales = ?, amount = ?, note = ?, status = 'pending', submitted_by = ?, submitted_at = ${NOW},
          verified_by = NULL, verified_at = NULL, verify_note = NULL WHERE id = ? RETURNING *`, s, amount, note, user.username, had.id)
      : await t.get("INSERT INTO cash_handovers (hub, date, sales, amount, note, submitted_by) VALUES (?,?,?,?,?,?) RETURNING *", hub, date, s, amount, note, user.username);
    return num(row);
  });
}

// The admin approves a handover, or sends it back with a reason.
async function verify(db, user, id, body) {
  const approve = body.approve === true || body.approve === "true";
  const note = String(body.note || "").trim().slice(0, 200) || null;
  if (!approve && !note) throw httpError(400, "Say why you are sending it back, so the coacher knows what to correct");
  return withUser(db, user.username, async (t) => {
    const row = await t.get("SELECT * FROM cash_handovers WHERE id = ?", Number(id));
    if (!row) throw httpError(404, "Handover not found");
    if (row.status !== "pending") throw httpError(409, `This handover is already ${row.status}`);
    const out = await t.get(`UPDATE cash_handovers SET status = ?, verified_by = ?, verified_at = ${NOW}, verify_note = ? WHERE id = ? RETURNING *`,
      approve ? "approved" : "rejected", user.username, note, row.id);
    return num(out);
  });
}

module.exports = { day, list, submit, verify, MIN_SHARE, minimum };
