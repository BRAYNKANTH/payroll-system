// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
// The connection pool is created once per warm instance and reused across requests.
const { createHandler } = require("../server");
const db = require("../db");

if (!process.env.DATABASE_URL) {
  module.exports = (req, res) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "DATABASE_URL is not set. Add your Neon connection string in Vercel → Settings → Environment Variables." }));
  };
} else {
  const ready = db.open(process.env.DATABASE_URL);
  ready.catch((err) => console.error("Database connection failed:", err.message));
  module.exports = createHandler(ready);
}
