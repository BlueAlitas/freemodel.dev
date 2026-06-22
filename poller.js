/* =================================================================
 * poller.js — freemodel.dev status backend
 * ----------------------------------------------------------------
 *  - Discovers Anthropic models per target from /v1/models
 *  - Probes each enabled model with a tiny /v1/messages request
 *  - Cadence: 30 min if last probe was 2xx, else 1 min until 2xx
 *  - Persists history to data/status.json
 *  - Exposes a small `state` object + EventEmitter for the server
 * ================================================================= */

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

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
  maxHistory:      envInt("MAX_HISTORY", 240),
  dataPath:        env("DATA_PATH", "./data/status.json"),
  probeTimeoutMs:  envInt("PROBE_TIMEOUT_MS", 15000),
};

/* ---------- persistence ---------- */
function loadState() {
  try {
    if (existsSync(CONFIG.dataPath)) {
      const raw = JSON.parse(readFileSync(CONFIG.dataPath, "utf-8"));
      if (raw && typeof raw === "object") return raw;
    }
  } catch (e) {
    console.warn("[poller] could not read state:", e.message);
  }
  return freshState();
}

function freshState() {
  return {
    targets: Object.fromEntries(CONFIG.targets.map(t => [t, {
      discoveredAt: 0,
      lastModelRefresh: 0,
      models: {},  // id -> { id, enabled, last: {ok,status,latency,ts,error?}, history: [] }
    }])),
    lastOkByTarget: {},     // target -> ts of most recent 2xx anywhere
    lastOkOverall: 0,
    lastCheckAt: 0,
    lastCycleAt: 0,
    cycleCount: 0,
  };
}

function saveState(state) {
  try {
    mkdirSync(dirname(CONFIG.dataPath), { recursive: true });
    writeFileSync(CONFIG.dataPath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[poller] save failed:", e.message);
  }
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

function reconcileModels(targetState, ids) {
  const incoming = new Set(ids);
  const known = new Set(Object.keys(targetState.models));

  // Add new models
  for (const id of incoming) {
    if (!known.has(id)) {
      targetState.models[id] = {
        id,
        enabled: CONFIG.testModels.includes(id),
        discoveredAt: Date.now(),
        last: null,
        history: [],
      };
      console.log(`[poller]   + model added: ${id}`);
    }
  }

  // Mark removed models (we KEEP history for graphing retirements)
  for (const id of known) {
    if (!incoming.has(id)) {
      targetState.models[id].removedAt = Date.now();
      targetState.models[id].enabled = false;
      console.log(`[poller]   - model removed: ${id}`);
    }
  }
  targetState.discoveredAt = Date.now();
  targetState.lastModelRefresh = Date.now();
}

/* ---------- probe ---------- */
function buildPayload(model) {
  // Tiny, cheap request — the gateway shouldn't bill much for max_tokens=1.
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

/* ---------- single probe cycle ---------- */
async function runCycle(state) {
  const cycleStarted = Date.now();
  state.cycleCount++;
  state.lastCycleAt = cycleStarted;

  for (const target of CONFIG.targets) {
    const tState = state.targets[target];

    // Discover models if stale
    const stale = Date.now() - (tState.lastModelRefresh || 0) > CONFIG.modelRefresh;
    if (!tState.discoveredAt || stale) {
      const ids = await discoverModels(target);
      if (ids) reconcileModels(tState, ids);
    }

    // Probe each enabled model
    const enabled = Object.values(tState.models).filter(m => m.enabled);
    if (enabled.length === 0) continue;

    const results = await Promise.all(enabled.map(async m => {
      const r = await probe(target, m.id);
      return { modelId: m.id, ...r };
    }));

    for (const r of results) {
      const m = tState.models[r.modelId];
      if (!m) continue;
      m.last = { ok: r.ok, status: r.status, latency: r.latency, ts: r.ts, error: r.error };
      m.history.push(m.last);
      if (m.history.length > CONFIG.maxHistory) {
        m.history.splice(0, m.history.length - CONFIG.maxHistory);
      }
      if (r.ok) {
        const prev = state.lastOkByTarget[target] || 0;
        if (r.ts > prev) state.lastOkByTarget[target] = r.ts;
        if (r.ts > state.lastOkOverall) state.lastOkOverall = r.ts;
      }
    }

    tState.lastCycleAt = cycleStarted;
  }

  state.lastCheckAt = cycleStarted;
  saveState(state);
  bus.emit("cycle", state);
}

/* ---------- scheduler ---------- */
function nextDelay(state) {
  // Use the most-recent probe across all targets to decide cadence.
  let latest = 0;
  let latestOk = true;
  for (const target of CONFIG.targets) {
    for (const m of Object.values(state.targets[target].models)) {
      if (!m.last) continue;
      if (m.last.ts >= latest) {
        latest = m.last.ts;
        latestOk = m.last.ok;
      }
    }
  }
  const base = latest || Date.now();
  const interval = latestOk ? CONFIG.intervalHealthy : CONFIG.intervalRetry;
  return Math.max(500, (base + interval) - Date.now());
}

async function scheduleLoop(state) {
  while (!stopped) {
    const delay = nextDelay(state);
    bus.emit("schedule", { nextAt: Date.now() + delay, delay });
    await wait(delay);
    if (stopped) return;
    try {
      await runCycle(state);
    } catch (e) {
      console.error("[poller] cycle error:", e);
    }
  }
}

/* ---------- public surface ---------- */
export const bus = new EventEmitter();
let stopped = false;

export function start() {
  const state = loadState();
  // Pre-seed empty target entries for any new URLs that didn't exist before
  for (const t of CONFIG.targets) {
    if (!state.targets[t]) {
      state.targets[t] = { discoveredAt: 0, lastModelRefresh: 0, models: {} };
    }
  }
  // Discover immediately on boot (don't wait 6h)
  (async () => {
    for (const target of CONFIG.targets) {
      const ids = await discoverModels(target);
      if (ids) reconcileModels(state.targets[target], ids);
    }
    saveState(state);
    bus.emit("cycle", state);
    scheduleLoop(state);
  })();
  return state;
}

export function stop() { stopped = true; }
export function getConfig() { return { ...CONFIG }; }

export { loadState, runCycle };
