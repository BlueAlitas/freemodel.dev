/* =================================================================
 * poller.js — freemodel.dev status backend (Postgres-backed)
 * ----------------------------------------------------------------
 *  - Discovers Anthropic models per target from /v1/models
 *  - Probes each enabled model with a tiny /v1/messages request
 *  - Cadence: 30 min if last probe was 2xx, else 1 min until 2xx
 *  - Persists every probe to Postgres; keeps an in-memory cache
 *    of the most recent probe per (target, model) for scheduling
 * ================================================================= */

import { EventEmitter } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { query, tx } from "./db.js";

const env = (k, dflt) => (process.env[k] ?? dflt);
const envList = (k, dflt) =>
  env(k, dflt).split(",").map(s => s.trim()).filter(Boolean);
const envInt = (k, dflt) => {
  const v = parseInt(env(k, dflt), 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const envMs = (k, dflt) => envInt(k, dflt);

const CONFIG = {
  targets: envList("TARGET_URLS", "https://cc.freemodel.dev,https://api-cc.freemodel.dev"),
  token: env("FREEMODEL_TOKEN", ""),
  anthropicVersion: env("ANTHROPIC_VERSION", "2023-06-01"),
  testModels: envList("TEST_MODELS", "claude-haiku-4-5-20251001"),
  intervalHealthy: envMs("INTERVAL_HEALTHY_MS", 30 * 60 * 1000),
  intervalRetry:   envMs("INTERVAL_RETRY_MS",       60 * 1000),
  modelRefresh:    envMs("MODEL_REFRESH_MS",     6 * 60 * 60 * 1000),
  probeTimeoutMs:  envInt("PROBE_TIMEOUT_MS", 15000),
};

function shouldProbeModel(id) {
  return CONFIG.testModels.includes("*") || CONFIG.testModels.includes(id);
}

/* ---------- in-memory cache ---------- */
// target -> modelId -> { last, history48 (just the most recent 48) }
const cache = new Map();
let lastOkByTarget = {};   // target -> ms epoch
let lastOkOverall = 0;
let lastCheckAt = 0;
let cycleCount = 0;
let lastModelRefresh = {}; // target -> ms epoch

function ensureTarget(t) {
  if (!cache.has(t)) cache.set(t, new Map());
  return cache.get(t);
}

function pushHistory(target, model, probe) {
  const m = ensureTarget(target).get(model);
  if (!m) return;
  m.last = probe;
  m.history48.push(probe);
  if (m.history48.length > 48) m.history48.shift();
}

/* ---------- discovery ---------- */
async function discoverModels(target) {
  const url = new URL("/v1/models", target).toString();
  const headers = { "accept": "application/json" };
  if (CONFIG.token) headers["authorization"] = `Bearer ${CONFIG.token}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.probeTimeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}`);
    const body = await res.json();
    const ids = (body?.data ?? [])
      .map(m => m?.id)
      .filter(id => typeof id === "string" && id.startsWith("claude-"));
    return ids;
  } catch (e) {
    console.warn(`[poller] model discovery failed for ${target}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function reconcileModels(target, ids) {
  const incoming = new Set(ids);
  // Existing in DB
  const { rows } = await query(
    `SELECT id, enabled, removed_at FROM models WHERE target = $1`,
    [target]
  );
  const known = new Map(rows.map(r => [r.id, r]));

  // Add new
  for (const id of incoming) {
    const enabled = shouldProbeModel(id);
    if (!known.has(id)) {
      await query(
        `INSERT INTO models (target, id, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (target, id) DO NOTHING`,
        [target, id, enabled]
      );
      ensureTarget(target).set(id, { last: null, history48: [] });
      console.log(`[poller]   + model added: ${id}`);
    } else if (known.get(id).removed_at || known.get(id).enabled !== enabled) {
      // Came back from the dead, or TEST_MODELS changed.
      await query(
        `UPDATE models SET removed_at = NULL, enabled = $3 WHERE target = $1 AND id = $2`,
        [target, id, enabled]
      );
    }
  }

  // Mark removed
  for (const [id, row] of known) {
    if (!incoming.has(id) && !row.removed_at) {
      await query(
        `UPDATE models SET removed_at = now(), enabled = false
         WHERE target = $1 AND id = $2`,
        [target, id]
      );
      console.log(`[poller]   - model removed: ${id}`);
    }
  }
  lastModelRefresh[target] = Date.now();
}

/* ---------- probe ---------- */
function buildPayload(model) {
  return {
    model,
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  };
}

async function probe(target, model) {
  const url = new URL("/v1/messages", target).toString();
  const headers = {
    "content-type": "application/json",
    "accept": "application/json",
    "anthropic-version": CONFIG.anthropicVersion,
  };
  if (CONFIG.token) headers["authorization"] = `Bearer ${CONFIG.token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.probeTimeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildPayload(model)),
      signal: ctrl.signal,
      cache: "no-store",
    });
    try { await res.arrayBuffer(); } catch {}
    const latency = performance.now() - start;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      latency,
      ts: Date.now(),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latency: performance.now() - start,
      ts: Date.now(),
      error: String(err?.name || err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- single cycle ---------- */
async function runCycle() {
  const started = Date.now();
  cycleCount++;
  lastCheckAt = started;

  for (const target of CONFIG.targets) {
    // Refresh models if stale
    const stale = !lastModelRefresh[target] ||
                  Date.now() - lastModelRefresh[target] > CONFIG.modelRefresh;
    if (stale) {
      const ids = await discoverModels(target);
      if (ids) await reconcileModels(target, ids);
    }

    // Load enabled models for this target
    const { rows: enabled } = await query(
      `SELECT id FROM models WHERE target = $1 AND enabled = true AND removed_at IS NULL`,
      [target]
    );
    if (enabled.length === 0) continue;

    // Probe all enabled models in parallel
    const results = await Promise.all(enabled.map(async m => {
      const r = await probe(target, m.id);
      return { modelId: m.id, ...r };
    }));

    // Persist + cache
    await tx(async client => {
      for (const r of results) {
        await client.query(
          `INSERT INTO probes (target, model, ok, status, latency_ms, ts, error)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7)`,
          [target, r.modelId, r.ok, r.status, r.latency, r.ts, r.error ?? null]
        );
        pushHistory(target, r.modelId, {
          ok: r.ok, status: r.status, latency: r.latency, ts: r.ts, error: r.error,
        });
        if (r.ok) {
          if (!lastOkByTarget[target] || r.ts > lastOkByTarget[target]) {
            lastOkByTarget[target] = r.ts;
          }
          if (r.ts > lastOkOverall) lastOkOverall = r.ts;
        }
      }
    });
  }

  bus.emit("cycle");
}

/* ---------- DB → cache bootstrap ---------- */
async function hydrate() {
  // Make sure the cache has an entry for every target/model in the DB
  const { rows: all } = await query(
    `SELECT target, id, enabled, removed_at FROM models`
  );
  for (const r of all) {
    const m = ensureTarget(r.target);
    if (!m.has(r.id)) m.set(r.id, { last: null, history48: [] });
  }

  // Pull the most recent 48 probes for every (target, model) so the
  // frontend has something to draw on first paint.
  const { rows: recent } = await query(`
    SELECT DISTINCT ON (target, model)
      target, model, ok, status, latency_ms, ts, error
    FROM probes
    ORDER BY target, model, ts DESC
  `);
  for (const r of recent) {
    const m = ensureTarget(r.target).get(r.model);
    if (!m) continue;
    m.last = {
      ok: r.ok, status: r.status,
      latency: Number(r.latency_ms),
      ts: new Date(r.ts).getTime(),
      error: r.error,
    };
  }
  // Pull last 48 per (target, model) for the sparkline
  const { rows: histRows } = await query(`
    SELECT * FROM (
      SELECT target, model, ok, status, latency_ms, ts, error,
             ROW_NUMBER() OVER (PARTITION BY target, model ORDER BY ts DESC) AS rn
      FROM probes
    ) s WHERE rn <= 48
    ORDER BY target, model, ts ASC
  `);
  for (const r of histRows) {
    const m = ensureTarget(r.target).get(r.model);
    if (!m) continue;
    m.history48.push({
      ok: r.ok, status: r.status,
      latency: Number(r.latency_ms),
      ts: new Date(r.ts).getTime(),
      error: r.error,
    });
  }

  // last-ok aggregates
  const { rows: okRows } = await query(`
    SELECT target, MAX(EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts
    FROM probes WHERE ok = true
    GROUP BY target
  `);
  for (const r of okRows) lastOkByTarget[r.target] = Number(r.ts);
  const { rows: okOverall } = await query(`
    SELECT MAX(EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts
    FROM probes WHERE ok = true
  `);
  if (okOverall[0]?.ts) lastOkOverall = Number(okOverall[0].ts);
}

/* ---------- scheduler ---------- */
function nextDelay() {
  let latest = 0, latestOk = true;
  for (const [, models] of cache) {
    for (const [, m] of models) {
      if (!m.last) continue;
      if (m.last.ts >= latest) { latest = m.last.ts; latestOk = m.last.ok; }
    }
  }
  const base = latest || Date.now();
  const interval = !latest || !latestOk ? CONFIG.intervalRetry : CONFIG.intervalHealthy;
  return Math.max(500, (base + interval) - Date.now());
}

async function scheduleLoop() {
  while (!stopped) {
    const delay = nextDelay();
    bus.emit("schedule", { nextAt: Date.now() + delay, delay });
    await wait(delay);
    if (stopped) return;
    try {
      await runCycle();
    } catch (e) {
      console.error("[poller] cycle error:", e);
    }
  }
}

async function runInitialCycleThenSchedule() {
  try {
    await runCycle();
  } catch (e) {
    console.error("[poller] initial cycle error:", e);
  }
  if (!stopped) scheduleLoop();
}

/* ---------- public surface ---------- */
export const bus = new EventEmitter();
let stopped = false;

export async function start() {
  await hydrate();
  for (const target of CONFIG.targets) {
    if (!cache.has(target)) cache.set(target, new Map());
    const ids = await discoverModels(target);
    if (ids) await reconcileModels(target, ids);
  }
  runInitialCycleThenSchedule();
}

export function stop() { stopped = true; }
export function getConfig() { return { ...CONFIG }; }

export function snapshot() {
  const targets = [];
  for (const target of CONFIG.targets) {
    const models = [];
    const m = cache.get(target) || new Map();
    for (const [id, data] of m) {
      models.push({
        id,
        last: data.last,
        history48: data.history48,
      });
    }
    targets.push({
      url: target,
      lastModelRefresh: lastModelRefresh[target] || null,
      lastOk: lastOkByTarget[target] || null,
      models,
    });
  }
  return {
    targets,
    lastOkOverall: lastOkOverall || null,
    lastCheckAt: lastCheckAt || null,
    cycleCount,
  };
}

export { CONFIG, cache, lastOkByTarget, lastOkOverall };
