/* =================================================================
 * server.js — freemodel.dev status page
 * ----------------------------------------------------------------
 *  Express app serving:
 *    GET  /             — the status page (public/index.html)
 *    GET  /api/status   — JSON snapshot consumed by the page
 *    GET  /api/health   — liveness for Traefik
 *    GET  /api/config   — public-safe runtime config (cadences, etc.)
 * ================================================================= */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as poller from "./poller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = express();
app.disable("x-powered-by");

// Static frontend
app.use(express.static(join(__dirname, "public"), {
  etag: true,
  maxAge: "15s",
  extensions: ["html"],
}));

/* ---------- helpers ---------- */
const pct = (n) => (n == null ? null : +(n * 100).toFixed(2));
const fmtMs = (n) => (n == null ? null : Math.round(n));
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
};

function summarize(history, windowMs = 60 * 60_000) {
  const now = Date.now();
  const recent = history.filter(h => now - h.ts <= windowMs);
  const latencies = recent.map(h => h.latency).sort((a, b) => a - b);
  const okCount  = recent.filter(h => h.ok).length;
  return {
    p10: quantile(latencies, 0.10),
    p50: quantile(latencies, 0.50),
    p90: quantile(latencies, 0.90),
    p99: quantile(latencies, 0.99),
    samples: recent.length,
    uptime1h: recent.length ? okCount / recent.length : null,
    last: recent.at(-1) ?? null,
  };
}

function aggregateState(rawState) {
  const config = poller.getConfig();
  const targets = Object.entries(rawState.targets).map(([url, t]) => {
    const models = Object.values(t.models)
      .sort((a, b) => {
        // enabled first, then by id; removed-last
        if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
        return a.id.localeCompare(b.id);
      })
      .map(m => {
        const s = summarize(m.history);
        // 24h uptime
        const day = m.history.filter(h => Date.now() - h.ts <= 24 * 3600_000);
        const uptime24 = day.length ? day.filter(h => h.ok).length / day.length : null;
        return {
          id: m.id,
          enabled: m.enabled,
          removedAt: m.removedAt ?? null,
          last: m.last,
          p10: fmtMs(s.p10),
          p50: fmtMs(s.p50),
          p90: fmtMs(s.p90),
          p99: fmtMs(s.p99),
          uptime1h: pct(s.uptime1h),
          uptime24: pct(uptime24),
          history48: m.history.slice(-48).map(h => ({
            ok: h.ok,
            status: h.status,
            latency: Math.round(h.latency),
            ts: h.ts,
          })),
        };
      });

    const enabledModels = models.filter(m => m.enabled);
    const latestOk = enabledModels.every(m => m.last?.ok);
    const latestAnyOk = enabledModels.some(m => m.last?.ok);
    const allFail = enabledModels.length > 0 && enabledModels.every(m => m.last && !m.last.ok);

    let status = "ok";
    if (!enabledModels.length || !enabledModels.some(m => m.last)) status = "unknown";
    else if (allFail) status = "down";
    else if (!latestOk) status = "warn";

    return {
      url,
      status,
      lastModelRefresh: t.lastModelRefresh || null,
      lastCycleAt: t.lastCycleAt || null,
      lastOk: rawState.lastOkByTarget[url] || null,
      models,
    };
  });

  // overall status
  let overall = "ok";
  const targetStatuses = targets.map(t => t.status);
  if (targetStatuses.some(s => s === "down")) overall = "down";
  else if (targetStatuses.some(s => s === "warn" || s === "unknown")) overall = "warn";
  else if (targetStatuses.length === 0) overall = "unknown";

  // global cadence: based on the latest probe overall (any target/model)
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
    overall,                  // "ok" | "warn" | "down" | "unknown"
    mode,                     // "healthy" | "rapid"
    cadenceMs: interval,
    nextCheckAt: nextAt,
    lastCheckAt: rawState.lastCheckAt || null,
    lastOkOverall: rawState.lastOkOverall || null,
    cycleCount: rawState.cycleCount || 0,
    targets,
  };
}

/* ---------- routes ---------- */
app.get("/api/status", (_req, res) => {
  // Always re-read state from disk so external writes (or restarts) are visible
  const raw = poller.loadState();
  res.set("cache-control", "no-store");
  res.json(aggregateState(raw));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
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

/* ---------- boot ---------- */
poller.start();

app.listen(PORT, () => {
  console.log(`[status] listening on http://localhost:${PORT}`);
  console.log(`[status] targets: ${poller.getConfig().targets.join(", ")}`);
  console.log(`[status] testing models: ${poller.getConfig().testModels.join(", ")}`);
});
