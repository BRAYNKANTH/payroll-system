// What a hub card shows: headcount, positions, sales and what needs attention. Used by the Dashboard and by the Hubs page so both agree.
import { get, qs } from "./api.js";
import { LEVELS } from "./ui.js";

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Everything the cards need, fetched once. `pay` says whether the signed-in user may see pay (only then is the review queue fetched).
// The sales and unconfirmed-day counts come from the small dashboard answer (a page that already has it passes it in, or the promise of it),
// not from the whole Live sales feed, which is about 30 times larger.
export async function loadHubData(period, pay, dash) {
  const dashP = dash || get("/api/dashboard" + qs({ period })).catch(() => ({ by_hub: [] }));
  const [hubs, staff, d, queue] = await Promise.all([
    get("/api/hubs"), get("/api/staff"), dashP,
    pay ? get("/api/review-queue").catch(() => []) : Promise.resolve([]),
  ]);
  const live = { people: (d.by_hub || []).map((h) => ({ hub: h.code, business: h.hub_business || 0, unconfirmed: h.unconfirmed || 0 })) };
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
    if (toReview) attention.push(["red", plural(toReview, "pay line to review", "pay lines to review"), toReview]);
    if (unconfirmed) attention.push(["amber", plural(unconfirmed, "day to confirm", "days to confirm"), unconfirmed]);
    return [h.code, {
      all, active, attention,
      sales: sold.reduce((t, p) => t + p.business, 0),
      levels: LEVELS.slice().reverse().map(([v]) => [v, active.filter((s) => s.staff_level === v).length]).filter(([, n]) => n),
      head: active.find((s) => s.is_coacher || s.staff_level === "coacher"),
      joined: all.filter((s) => (s.join_date || "").startsWith(period)).length,
      left: all.filter((s) => (s.leave_date || "").startsWith(period)).length,
    }];
  }));
}
