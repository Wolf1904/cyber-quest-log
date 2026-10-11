// Vercel serverless function: GET loads the save, PUT stores it.
// Needs these environment variables in Vercel:
//   SYNC_PASSPHRASE                      – your own passphrase (8+ characters)
//   KV_REST_API_URL / KV_REST_API_TOKEN  – added automatically when you connect Upstash Redis
//   (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN also work)
const crypto = require("crypto");

const KEY = "thm-roadmap:save";
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PASS = process.env.SYNC_PASSPHRASE || "";

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Redis responded ${r.status}`);
  return (await r.json()).result;
}

function authorized(req) {
  const given = Buffer.from(String(req.headers["x-sync-key"] || ""));
  const want = Buffer.from(PASS);
  return PASS.length >= 8 && given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN || PASS.length < 8) {
    return res.status(500).json({ error: "Server not configured: connect Upstash Redis and set SYNC_PASSPHRASE (8+ characters)." });
  }
  if (!authorized(req)) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return res.status(401).json({ error: "Wrong passphrase" });
  }
  try {
    if (req.method === "GET") {
      const raw = await redis(["GET", KEY]);
      return res.status(200).json({ save: raw ? JSON.parse(raw) : null });
    }
    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== "object" || !Array.isArray(body.weeks)) {
        return res.status(400).json({ error: "That doesn't look like a roadmap save." });
      }
      const text = JSON.stringify(body);
      if (text.length > 500000) return res.status(413).json({ error: "Save is too large." });
      // Never let an older device overwrite a newer save.
      const raw = await redis(["GET", KEY]);
      if (raw) {
        const current = JSON.parse(raw);
        if ((current.updatedAt || 0) > (body.updatedAt || 0)) return res.status(409).json({ save: current });
      }
      await redis(["SET", KEY, text]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(502).json({ error: "Storage is unavailable right now." });
  }
};
