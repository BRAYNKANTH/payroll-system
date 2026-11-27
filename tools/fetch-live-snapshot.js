// Refreshes data/live-snapshot.json from a live site, for seed-scenarios.js.
//   node tools/fetch-live-snapshot.js <site address> <admin user> <admin password>
// It only reads (hubs, people, settings). The snapshot stays in data/ (never committed) and is used to build a local demo.
const fs = require("fs");
const path = require("path");
const [base, user, pass] = process.argv.slice(2);
if (!base || !user || !pass) { console.log("Usage: node tools/fetch-live-snapshot.js <site address> <admin user> <admin password>"); process.exit(1); }
(async () => {
  const H = { "Content-Type": "application/json", "X-Requested-With": "fetch" };
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ username: user, password: pass }) });
  if (!login.ok) { console.log("Sign-in failed:", login.status); process.exit(1); }
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const get = async (p) => (await fetch(base + p, { headers: { ...H, cookie } })).json();
  const snap = { taken: new Date().toISOString(), hubs: await get("/api/hubs"), staff: await get("/api/staff"), settings: await get("/api/settings") };
  fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "data", "live-snapshot.json"), JSON.stringify(snap, null, 1));
  console.log(`Saved ${snap.hubs.length} hubs and ${snap.staff.length} people.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
