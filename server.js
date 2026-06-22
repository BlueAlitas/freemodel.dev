/* =================================================================
 * server.js — freemodel.dev status page
 * ----------------------------------------------------------------
 *  HTTP API + static frontend + lightweight unique visitor tracking
 *
 *  Routes:
 *    GET  /                       status page
 *    GET  /api/status             full snapshot
 *    GET  /api/health             liveness
 *    GET  /api/config             public config
 *    GET  /api/stats              unique visitor stats (today, active, 30d)
 *    GET  /api/visits/recent      recent visit log (admin)
 *
 *  Visitor tracking:
 *    - Every tracked page request is grouped by a one-way hash of
 *      client IP + User-Agent. We store one visit row per unique
 *      fingerprint and update sessions.last_seen for activity.
 *    - Country is read from cf-ipcountry / x-vercel-ip-country /
 *      x-country headers when present.
 * ================================================================= */

import express from "express";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

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

function readClientIp(req) {
  const forwarded = req.get("cf-connecting-ip") ||
    req.get("x-real-ip") ||
    req.ip ||
    req.socket?.remoteAddress ||
    "";
  return String(forwarded).split(",")[0].trim().replace(/^::ffff:/, "") || "unknown";
}

function visitorIdFor(req, userAgent) {
  const ip = readClientIp(req);
  return createHash("sha256")
    .update(ip)
    .update("\0")
    .update(userAgent || "unknown")
    .digest("hex")
    .slice(0, 40);
}

app.use((req, res, next) => {
  if (!shouldTrack(req)) return next();

  const country = readCountry(req);
  const ua = (req.get("user-agent") || "").slice(0, 512);
  const ref = (req.get("referer") || req.get("referrer") || "").slice(0, 512);
  const path = req.path.slice(0, 512);
  const vid = visitorIdFor(req, ua);

  // Expire the legacy cookie-based visitor id. Visitor identity is now
  // derived from IP + User-Agent and stored only as a one-way hash.
  res.clearCookie("fm_vid", { path: "/", sameSite: "lax" });

  // Fire-and-forget. We do NOT await — we don't want tracking to
  // add latency to page loads. Failures are logged and dropped.
  (async () => {
    const { rows } = await query(`
      WITH inserted AS (
        INSERT INTO sessions (visitor_id, first_seen, last_seen)
        VALUES ($1, now(), now())
        ON CONFLICT (visitor_id) DO NOTHING
        RETURNING visitor_id
      ),
      updated AS (
        UPDATE sessions
        SET last_seen = now()
        WHERE visitor_id = $1
          AND NOT EXISTS (SELECT 1 FROM inserted)
        RETURNING visitor_id
      )
      SELECT
        EXISTS (SELECT 1 FROM inserted) AS is_new,
        EXISTS (SELECT 1 FROM updated) AS was_seen
    `, [vid]);

    if (rows[0]?.is_new) {
      await query(
        `INSERT INTO visits (visitor_id, path, referrer, user_agent, country)
         VALUES ($1, $2, $3, $4, $5)`,
        [vid, path, ref || null, ua || null, country]
      );
    }
  })().catch(err => console.warn("[visits] tracking failed:", err.message));

  // Expose for downstream handlers if needed
  req.visitorId = vid;
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
 * Percentiles (last hour) + uptime (last 24h) for a (target, model).
 * Computed as two cheap aggregations that can both use the existing
 * (target, model, ts DESC) index.
 */
async function modelStats(target, modelId) {
  const sql = `
    WITH h1 AS (
      SELECT ok, latency_ms FROM probes
      WHERE target = $1 AND model = $2
        AND ts > now() - interval '1 hour'
    ),
    d24 AS (
      SELECT count(*) FILTER (WHERE ok)::float8 AS ok_n,
             count(*)::float8                   AS total_n
      FROM probes
      WHERE target = $1 AND model = $2
        AND ts > now() - interval '24 hours'
    )
    SELECT
      (SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY latency_ms)::float8 FROM h1) AS p10,
      (SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::float8 FROM h1) AS p50,
      (SELECT percentile_cont(0.90) WITHIN GROUP (ORDER BY latency_ms)::float8 FROM h1) AS p90,
      (SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::float8 FROM h1) AS p99,
      (SELECT count(*)::int FROM h1) AS samples_1h,
      (SELECT ok_n FROM d24)         AS ok_n,
      (SELECT total_n FROM d24)      AS total_n
  `;
  const { rows } = await query(sql, [target, modelId]);
  const r = rows[0] || {};
  return {
    p10: fmtMs(r.p10),
    p50: fmtMs(r.p50),
    p90: fmtMs(r.p90),
    p99: fmtMs(r.p99),
    samples1h: r.samples_1h ?? 0,
    uptime24: r.total_n ? pct(r.ok_n / r.total_n) : null,
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

    const lastError = enabled
      .filter(m => m.last && !m.last.ok && m.last.error)
      .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0))
      .map(m => ({
        model: m.id,
        status: m.last.status,
        error: m.last.error,
        ts: m.last.ts,
      }))[0] || null;

    targets.push({
      url: t.url,
      status,
      lastModelRefresh: t.lastModelRefresh,
      lastCycleAt: snap.lastCheckAt,
      lastOk: t.lastOk,
      lastError,
      models: enriched,
    });
  }

  // Overall status
  let overall = "ok";
  const ss = targets.map(t => t.status);
  if (ss.length === 0 || ss.every(s => s === "unknown")) overall = "unknown";
  else if (ss.some(s => s === "down")) overall = "down";
  else if (ss.some(s => s === "warn" || s === "unknown")) overall = "warn";

  // Cadence based on most recent probe overall
  let latest = 0, latestOk = true;
  for (const t of targets) {
    for (const m of t.models) {
      if (!m.last) continue;
      if (m.last.ts >= latest) { latest = m.last.ts; latestOk = m.last.ok; }
    }
  }
  const interval = !latest || !latestOk ? config.intervalRetry : config.intervalHealthy;
  const nextAt = latest ? latest + interval : Date.now() + interval;
  const mode = latest && latestOk ? "healthy" : "rapid";

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
    // Unique visitors today, based on first_seen.
    const { rows: todayRows } = await query(`
      SELECT count(*)::int AS unique_visitors
      FROM sessions
      WHERE first_seen >= date_trunc('day', now())
    `);

    // Active unique visitors.
    const { rows: activeRows } = await query(`
      SELECT count(*)::int AS active
      FROM sessions
      WHERE last_seen > now() - ($1 || ' minutes')::interval
    `, [String(ACTIVE_WINDOW_MIN)]);

    // Unique visitors over the last 30 days.
    const { rows: dailyRows } = await query(`
      SELECT to_char(date_trunc('day', first_seen), 'YYYY-MM-DD') AS day,
             count(*)::int AS unique_visitors
      FROM sessions
      WHERE first_seen > now() - interval '30 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const { rows: totalRows } = await query(`
      SELECT count(*)::int AS unique_visitors
      FROM sessions
      WHERE first_seen > now() - interval '30 days'
    `);

    // Top countries by first tracked visit in the last 30 days.
    const { rows: countryRows } = await query(`
      WITH first_visit AS (
        SELECT DISTINCT ON (visitor_id)
          visitor_id,
          COALESCE(country, '??') AS country
        FROM visits
        WHERE ts > now() - interval '30 days'
        ORDER BY visitor_id, ts ASC
      )
      SELECT country, count(*)::int AS unique_visitors
      FROM first_visit
      GROUP BY country
      ORDER BY unique_visitors DESC
      LIMIT 8
    `);

    const todayUnique = todayRows[0]?.unique_visitors ?? 0;
    res.set("cache-control", "no-store");
    res.json({
      today: { visits: todayUnique, unique_visitors: todayUnique },
      activeNow: activeRows[0]?.active ?? 0,
      activeWindowMin: ACTIVE_WINDOW_MIN,
      total30dUnique: totalRows[0]?.unique_visitors ?? 0,
      daily: dailyRows.map(r => ({
        day: r.day,
        visits: r.unique_visitors,
        unique_visitors: r.unique_visitors,
      })),
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
