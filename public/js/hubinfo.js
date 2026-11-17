// What a hub card shows: headcount, positions, sales and what needs attention. Used by the Dashboard and by the Hubs page so both agree.
import { get, qs } from "./api.js";
import { LEVELS } from "./ui.js";

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Everything the cards need, fetched once. `pay` says whether the signed-in user may see pay (only then is the review queue fetched).
export async function loadHubData(period, pay) {
  const [hubs, staff, live, queue] = await Promise.all([
    get("/api/hubs"), get("/api/staff"),
    get("/api/live" + qs({ period })).catch(() => ({ people: [] })),
    pay ? get("/api/review-queue").catch(() => []) : Promise.resolve([]),
  ]);
  return { hubs, staff, live, queue };
}

// One object per hub code: { all, active, attention: [[tone, text, count]], sales, levels, head, joined, left }.
export function hubInfo({ hubs, staff, live, queue }, period) {
  return Object.fromEntries(hubs.map((h) => {
    const all = staff.filter((s) => s.hub === h.code);
    const active = all.filter((s) => s.status === "active");
    const sold = live.people.filter((p) => p.hub === h.code);
    const attention = [];
    const toReview = queue.filter((r) => r.hub === h.code && r.period === period).length;
    const unconfirmed = sold.reduce((t, p) => t + (p.unconfirmed || 0), 0);
    const noBank = active.filter((s) => !s.bank_account_no).length;
    const unverified = active.filter((s) => s.bank_account_no && s.bank_account_no !== s.bank_account_verified).length;
    if (toReview) attention.push(["red", plural(toReview, "pay line to review", "pay lines to review"), toReview]);
    if (unconfirmed) attention.push(["amber", plural(unconfirmed, "day to confirm", "days to confirm"), unconfirmed]);
    if (noBank) attention.push(["amber", plural(noBank, "person without a bank account", "people without a bank account"), noBank]);
    if (unverified) attention.push(["amber", plural(unverified, "unverified bank account", "unverified bank accounts"), unverified]);
    return [h.code, {
      all, active, attention,
      sales: sold.reduce((t, p) => t + p.business, 0),
      levels: LEVELS.slice().reverse().map(([v]) => [v, active.filter((s) => s.staff_level === v).length]).filter(([, n]) => n),
      head: active.find((s) => s.staff_level === "coacher"),
      joined: all.filter((s) => (s.join_date || "").startsWith(period)).length,
      left: all.filter((s) => (s.leave_date || "").startsWith(period)).length,
    }];
  }));
}
