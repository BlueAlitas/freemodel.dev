/* =================================================================
 * server.js — freemodel.dev status page
 * ----------------------------------------------------------------
 *  HTTP API + static frontend + visitor tracking
 *
 *  Routes:
 *    GET  /                       status page
 *    GET  /api/status             full snapshot
 *    GET  /api/health             liveness
 *    GET  /api/config             public config
 *    GET  /api/stats              visitor stats (today, active, 30d)
 *    GET  /api/visits/recent      recent visit log (admin)
 *
 *  Visitor tracking:
 *    - Every non-`/api/` request gets a `fm_vid` HttpOnly cookie
 *      (1y) if it doesn't have one. Cookies are refreshed each
 *      hit so `sessions.last_seen` accurately tracks activity.
 *    - Country is read from cf-ipcountry / x-vercel-ip-country /
 *      x-country headers when present.
 * ================================================================= */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { init as dbInit, query } from "./db.js";
import * as poller from "./poller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const ACTIVE_WINDOW_MIN = parseInt(process.env.ACTIVE_WINDOW_MIN ?? "5", 10);
const TRACK_PATHS = process.env.TRACK_PATHS ?? "/";     // comma-separated, prefix matches

/* ---------- express ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // honour X-Forwarded-For from Traefik

// Tiny body parser for /api/visits (we don't accept bodies elsewhere)
app.use(express.json({ limit: "32kb" }));

/* ---------- cookie parser (tiny, avoids cookie-parser dep) ---------- */
app.use((req, res, next) => {
  const header = req.headers.cookie;
  if (!header) { req.cookies = {}; return next(); }
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  req.cookies = out;
  next();
});

/* ---------- visitor tracking middleware ---------- */
const trackPrefixes = TRACK_PATHS.split(",").map(s => s.trim()).filter(Boolean);

function shouldTrack(req) {
  if (req.method !== "GET") return false;
  if (req.path.startsWith("/api/")) return false;
  if (req.path === "/api/health") return false;
  return trackPrefixes.some(p => req.path === p || req.path.startsWith(p + "/") || p === "/");
}

function readCountry(req) {
  return (
    req.get("cf-ipcountry") ||
    req.get("x-vercel-ip-country") ||
    req.get("x-country") ||
    null
  );
}

app.use(async (req, res, next) => {
  if (!shouldTrack(req)) return next();

  let vid = req.cookies?.fm_vid;
  let isNew = false;
  if (!vid) {
    vid = randomUUID();
    isNew = true;
  }
  res.cookie("fm_vid", vid, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    maxAge: 365 * 24 * 60 * 60 * 1000,   // 1 year
    path: "/",
  });

  const country = readCountry(req);
  const ua = (req.get("user-agent") || "").slice(0, 512);
  const ref = (req.get("referer") || req.get("referrer") || "").slice(0, 512);
  const path = req.path.slice(0, 512);

  // Fire-and-forget. We do NOT await — we don't want tracking to
  // add latency to page loads. Failures are logged and dropped.
  Promise.allSettled([
    query(
      `INSERT INTO visits (visitor_id, path, referrer, user_agent, country)
       VALUES ($1, $2, $3, $4, $5)`,
      [vid, path, ref || null, ua || null, country]
    ),
    query(
      `INSERT INTO sessions (visitor_id, first_seen, last_seen)
       VALUES ($1, now(), now())
       ON CONFLICT (visitor_id) DO UPDATE SET last_seen = now()`,
      [vid]
    ),
  ]).catch(err => console.warn("[visits] insert failed:", err.message));

  // Expose for downstream handlers if needed
  req.visitorId = vid;
  req.visitorIsNew = isNew;
  next();
});

/* ---------- cookie parser (tiny, avoids cookie-parser dep) ---------- */
app.use((req, res, next) => {
  const header = req.headers.cookie;
  if (!header) { req.cookies = {}; return next(); }
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  req.cookies = out;
  next();
});

/* ---------- static ---------- */
app.use(express.static(join(__dirname, "public"), {
  etag: true,
  maxAge: "15s",
  extensions: ["html"],
}));

/* ---------- helpers ---------- */
const pct = (n) => (n == null ? null : +(n * 100).toFixed(2));
const fmtMs = (n) => (n == null ? null : Math.round(n));
const STATUS_LABEL = {
  ok: "Operational",
  warn: "Degraded",
  bad: "Disrupted",
  down: "Down",
  unknown: "Awaiting probes…",
};

/**
 * Run a SQL percentile agg over a window for a single (target, model).
 * Returns { p10, p50, p90, p99, uptime1h, uptime24, samples1h, samples24, history48 }.
 */
async function modelStats(target, modelId) {
  const sql = `
    WITH windowed AS (
      SELECT ok, status, latency_ms,
             EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms
      FROM probes
      WHERE target = $1 AND model = $2
        AND ts > now() - interval '24 hours'
    ),
    pct AS (
      SELECT
        percentile_cont(0.10) WITHIN GROUP (ORDER BY latency_ms) AS p10,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY latency_ms) AS p90,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99,
        count(*) FILTER (WHERE EXTRACT(EPOCH FROM ts_ms/1000) > EXTRACT(EPOCH FROM now() - interval '1 hour')) AS n1h,
        count(*) FILTER (WHERE ok) AS n_ok_24,
        count(*) AS n_24
      FROM windowed
    )
    SELECT
      (SELECT p10 FROM pct)::float8 AS p10,
      (SELECT p50 FROM pct)::float8 AS p50,
      (SELECT p90 FROM pct)::float8 AS p90,
      (SELECT p99 FROM pct)::float8 AS p99,
      (SELECT n1h FROM pct)::int      AS samples_1h,
      (SELECT n_ok_24 FROM pct)::int AS ok_24,
      (SELECT n_24 FROM pct)::int    AS n_24
  `;
  const { rows } = await query(sql, [target, modelId]);
  const r = rows[0] || {};
  return {
    p10: fmtMs(r.p10),
    p50: fmtMs(r.p50),
    p90: fmtMs(r.p90),
    p99: fmtMs(r.p99),
    samples1h: r.samples_1h ?? 0,
    uptime24: r.n_24 ? r.ok_24 / r.n_24 : null,
  };
}

async function history48(target, modelId) {
  const { rows } = await query(`
    SELECT ok, status, latency_ms,
           EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms,
           error
    FROM probes
    WHERE target = $1 AND model = $2
    ORDER BY ts DESC
    LIMIT 48
  `, [target, modelId]);
  return rows.reverse().map(r => ({
    ok: r.ok,
    status: r.status,
    latency: Math.round(Number(r.latency_ms)),
    ts: Number(r.ts_ms),
    error: r.error,
  }));
}

async function buildStatusPayload() {
  const cfg = poller.getConfig();
  const snap = poller.snapshot();
  const config = cfg;

  // Load model metadata (enabled, removed_at)
  const { rows: metaRows } = await query(`SELECT target, id, enabled, removed_at FROM models`);
  const meta = new Map();
  for (const r of metaRows) {
    if (!meta.has(r.target)) meta.set(r.target, new Map());
    meta.get(r.target).set(r.id, r);
  }

  const targets = [];
  for (const t of snap.targets) {
    const enriched = [];
    for (const m of t.models) {
      const mm = meta.get(t.url)?.get(m.id);
      const stats = await modelStats(t.url, m.id);
      const hist = m.history48 && m.history48.length
        ? m.history48
        : await history48(t.url, m.id);
      enriched.push({
        id: m.id,
        enabled: mm?.enabled ?? true,
        removedAt: mm?.removed_at ? new Date(mm.removed_at).getTime() : null,
        last: m.last,
        ...stats,
        history48: hist,
      });
    }

    enriched.sort((a, b) => {
      if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    const enabled = enriched.filter(m => m.enabled);
    let status = "ok";
    if (!enabled.length || !enabled.some(m => m.last)) status = "unknown";
    else if (enabled.every(m => m.last && !m.last.ok)) status = "down";
    else if (!enabled.every(m => m.last?.ok)) status = "warn";

    targets.push({
      url: t.url,
      status,
      lastModelRefresh: t.lastModelRefresh,
      lastCycleAt: null,
      lastOk: t.lastOk,
      models: enriched,
    });
  }

  // Overall status
  let overall = "ok";
  const ss = targets.map(t => t.status);
  if (ss.some(s => s === "down")) overall = "down";
  else if (ss.some(s => s === "warn" || s === "unknown")) overall = "warn";
  else if (ss.length === 0) overall = "unknown";

  // Cadence based on most recent probe overall
  let latest = 0, latestOk = true;
  for (const t of targets) {
    for (const m of t.models) {
      if (!m.last) continue;
      if (m.last.ts >= latest) { latest = m.last.ts; latestOk = m.last.ok; }
    }
  }
  const interval = latestOk ? config.intervalHealthy : config.intervalRetry;
  const nextAt = latest ? latest + interval : Date.now() + interval;
  const mode = latestOk ? "healthy" : "rapid";

  return {
    overall,
    mode,
    cadenceMs: interval,
    nextCheckAt: nextAt,
    lastCheckAt: snap.lastCheckAt,
    lastOkOverall: snap.lastOkOverall,
    cycleCount: snap.cycleCount,
    statusLabels: STATUS_LABEL,
    targets,
  };
}

/* ---------- API routes ---------- */
app.get("/api/status", async (_req, res) => {
  try {
    const payload = await buildStatusPayload();
    res.set("cache-control", "no-store");
    res.json(payload);
  } catch (e) {
    console.error("[api/status] error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get("/api/config", (_req, res) => {
  const c = poller.getConfig();
  res.json({
    intervalHealthyMs: c.intervalHealthy,
    intervalRetryMs: c.intervalRetry,
    modelRefreshMs: c.modelRefresh,
    testModels: c.testModels,
    targets: c.targets,
  });
});

app.get("/api/stats", async (_req, res) => {
  try {
    // Today
    const { rows: todayRows } = await query(`
      SELECT count(*)::int AS visits,
             count(DISTINCT visitor_id)::int AS unique_visitors
      FROM visits
      WHERE ts >= date_trunc('day', now())
    `);

    // Active now
    const { rows: activeRows } = await query(`
      SELECT count(*)::int AS active
      FROM sessions
      WHERE last_seen > now() - ($1 || ' minutes')::interval
    `, [String(ACTIVE_WINDOW_MIN)]);

    // Last 30 days
    const { rows: dailyRows } = await query(`
      SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day,
             count(*)::int AS visits,
             count(DISTINCT visitor_id)::int AS unique_visitors
      FROM visits
      WHERE ts > now() - interval '30 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    // Top countries (last 30 days)
    const { rows: countryRows } = await query(`
      SELECT COALESCE(country, '??') AS country,
             count(DISTINCT visitor_id)::int AS unique_visitors
      FROM visits
      WHERE ts > now() - interval '30 days'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 8
    `);

    res.set("cache-control", "no-store");
    res.json({
      today: todayRows[0] || { visits: 0, unique_visitors: 0 },
      activeNow: activeRows[0]?.active ?? 0,
      activeWindowMin: ACTIVE_WINDOW_MIN,
      daily: dailyRows,
      topCountries: countryRows,
    });
  } catch (e) {
    console.error("[api/stats] error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/visits/recent", async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit ?? "50", 10));
  try {
    const { rows } = await query(`
      SELECT visitor_id, path, referrer, country, ts
      FROM visits
      ORDER BY ts DESC
      LIMIT $1
    `, [limit]);
    res.json({ visits: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- boot ---------- */
(async () => {
  await dbInit();
  await poller.start();
  app.listen(PORT, () => {
    const c = poller.getConfig();
    console.log(`[status] listening on http://localhost:${PORT}`);
    console.log(`[status] targets:    ${c.targets.join(", ")}`);
    console.log(`[status] test models: ${c.testModels.join(", ")}`);
    console.log(`[status] active window: ${ACTIVE_WINDOW_MIN} min`);
  });
})().catch(err => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
