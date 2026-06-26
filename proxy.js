import express from "express";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { setGlobalDispatcher, Agent as UndiciAgent, ProxyAgent, Socks5ProxyAgent } from "undici";

// Default undici dispatcher tuned for high concurrency
if (!process.env.FM_NO_UNDICI_TUNE) {
  setGlobalDispatcher(new UndiciAgent({
    connections: 256,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 120000,
  }));
}

const DEFAULT_TARGETS = {
  T2: "https://api-cc.freemodel.dev",
  T0: "https://cc.freemodel.dev",
};
const DEFAULT_PROXY_PROCESS_ID = randomId("proc", 12);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const DECOMPRESSED_RESPONSE_HEADERS = new Set([
  "content-encoding",
]);
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
]);

const NO_BODY_METHODS = new Set(["GET", "HEAD"]);
const TOKEN_PREFIX_RE = /^(bearer|barear)\s+/i;

const clip = (value, max = 240) => {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

const intEnv = (env, key, fallback) => {
  const value = parseInt(env[key] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const nonNegativeIntEnv = (env, key, fallback) => {
  const value = parseInt(env[key] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const normalizeBaseUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

export function getProxyConfig(env = process.env) {
  return {
    targets: {
      T2: normalizeBaseUrl(env.PROXY_T2_URL || DEFAULT_TARGETS.T2),
      T0: normalizeBaseUrl(env.PROXY_T0_URL || DEFAULT_TARGETS.T0),
    },
    retriesPerCredential: intEnv(env, "PROXY_RETRIES_PER_CREDENTIAL", 3),
    bodyLimit: env.PROXY_BODY_LIMIT || "20mb",
    failureBodyDrainBytes: intEnv(env, "PROXY_FAILURE_DRAIN_BYTES", 64 * 1024),
    successBodyBufferBytes: nonNegativeIntEnv(env, "PROXY_SUCCESS_BUFFER_BYTES", 0),
    accountCacheMs: nonNegativeIntEnv(env, "PROXY_ACCOUNT_CACHE_MS", 2000),
    accountCacheMax: intEnv(env, "PROXY_ACCOUNT_CACHE_MAX", 50000),
    processHeartbeatMs: intEnv(env, "PROXY_PROCESS_HEARTBEAT_MS", 30_000),
    processStaleMs: intEnv(env, "PROXY_PROCESS_STALE_MS", 5 * 60_000),
    staleCleanupIntervalMs: intEnv(env, "PROXY_STALE_CLEANUP_INTERVAL_MS", 60_000),
    legacyActiveRequestStaleMs: intEnv(env, "PROXY_LEGACY_ACTIVE_REQUEST_STALE_MS", 6 * 60 * 60_000),
    adminToken: env.ADMIN_TOKEN || "",
    keySecret: env.PROXY_KEY_SECRET || env.ADMIN_TOKEN || "",
  };
}

export function extractAuthorizationToken(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").trim().replace(TOKEN_PREFIX_RE, "").trim();
}

export function bearerHeader(token) {
  const clean = extractAuthorizationToken(token);
  return clean ? `Bearer ${clean}` : null;
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function randomId(prefix, bytes = 18) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

export function normalizeTier(value) {
  const tier = String(value || "").trim().toUpperCase();
  return tier === "T0" || tier === "T2" ? tier : null;
}

const tierRank = (tier) => (tier === "T2" ? 0 : 1);

function normalizePriority(value) {
  const n = parseInt(value ?? "100", 10);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(1_000_000, n));
}

function sanitizeLabel(value) {
  const s = String(value ?? "").trim();
  return s ? clip(s, 80) : null;
}

export function keyHint(token) {
  const clean = extractAuthorizationToken(token);
  if (!clean) return "";
  if (clean.length <= 12) return `${clean.slice(0, 3)}…${clean.slice(-2)}`;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

function encryptionKey(secret) {
  return createHash("sha256").update(String(secret || "freemodel-status-dev-secret")).digest();
}

export function encryptSecret(value, secret = getProxyConfig().keySecret) {
  const text = extractAuthorizationToken(value);
  if (!secret) {
    return `plain:${Buffer.from(text, "utf8").toString("base64url")}`;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${body.toString("base64url")}`;
}

export function decryptSecret(payload, secret = getProxyConfig().keySecret) {
  const value = String(payload || "");
  if (value.startsWith("plain:")) {
    return Buffer.from(value.slice(6), "base64url").toString("utf8");
  }

  const [version, ivText, tagText, bodyText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !bodyText) {
    throw new Error("Unsupported secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function buildDirectAttemptPlan(token, config = getProxyConfig()) {
  const clean = extractAuthorizationToken(token);
  return ["T2", "T0"]
    .filter((tier) => config.targets[tier])
    .map((tier) => ({
      tier,
      upstreamBaseUrl: config.targets[tier],
      token: clean || null,
      accountKeyId: null,
      priority: 100,
      maxAttempts: config.retriesPerCredential,
    }));
}

export function buildAccountAttemptPlan(keys, config = getProxyConfig()) {
  return [...(keys || [])]
    .filter((key) => key?.enabled !== false && normalizeTier(key?.tier) && key?.apiKey)
    .sort((a, b) => (
      tierRank(normalizeTier(a.tier)) - tierRank(normalizeTier(b.tier)) ||
      normalizePriority(a.priority) - normalizePriority(b.priority) ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
    ))
    .map((key) => {
      const tier = normalizeTier(key.tier);
      return {
        tier,
        upstreamBaseUrl: config.targets[tier],
        token: extractAuthorizationToken(key.apiKey),
        accountKeyId: key.id,
        priority: normalizePriority(key.priority),
        maxAttempts: config.retriesPerCredential,
      };
    })
    .filter((step) => step.upstreamBaseUrl && step.token);
}

function proxyPathFromRequest(req) {
  const original = req.originalUrl || req.url || "/";
  return original.startsWith("/proxy/")
    ? original.slice("/proxy".length) || "/"
    : original;
}

function rawBodyFromRequest(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body == null) return Buffer.alloc(0);
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (typeof req.body === "object") return Buffer.alloc(0);
  return Buffer.from(req.body);
}

function extractRequestModel(rawBody, contentType) {
  if (!rawBody?.length || !String(contentType || "").includes("json")) return null;
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    return typeof parsed?.model === "string" ? clip(parsed.model, 160) : null;
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(req, token) {
  const headers = {};
  const cleanToken = extractAuthorizationToken(token);
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "accept-encoding") continue;
    if (CREDENTIAL_HEADERS.has(lower)) continue;
    if (value == null) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  const authorization = bearerHeader(cleanToken);
  if (authorization) headers.authorization = authorization;
  else delete headers.authorization;
  if (cleanToken && req.get("x-api-key")) headers["x-api-key"] = cleanToken;
  if (cleanToken && req.get("anthropic-api-key")) headers["anthropic-api-key"] = cleanToken;

  headers.accept = headers.accept || "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

async function drainFailureBody(response, maxBytes) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.byteLength || 0;
      if (seen >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    // Draining is best-effort. The body is intentionally discarded.
  }
}

async function readSuccessfulBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel();
        throw new Error(`Successful response exceeded ${maxBytes} byte buffer limit`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, seen);
  } finally {
    reader.releaseLock();
  }
}

async function fetchAttempt({ req, rawBody, path, step, fetchImpl, config, signal }) {
  const upstreamUrl = new URL(path, step.upstreamBaseUrl).toString();
  const started = performance.now();
  try {
    const options = {
      method: req.method,
      headers: buildUpstreamHeaders(req, step.token),
      redirect: "manual",
      signal,
    };
    if (!NO_BODY_METHODS.has(req.method.toUpperCase())) {
      options.body = rawBody;
    }

    const response = await fetchImpl(upstreamUrl, options);
    const headerLatency = performance.now() - started;
    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      await drainFailureBody(response, config.failureBodyDrainBytes);
      return {
        ok: false,
        status: response.status,
        latencyMs: performance.now() - started,
        error: `HTTP ${response.status}`,
        tier: step.tier,
        upstreamUrl,
        accountKeyId: step.accountKeyId,
      };
    }

    let body = null;
    if (config.successBodyBufferBytes > 0) {
      try {
        body = await readSuccessfulBody(response, config.successBodyBufferBytes);
      } catch (err) {
        return {
          ok: false,
          status: response.status,
          latencyMs: performance.now() - started,
          error: clip(err?.message || err?.name || err),
          tier: step.tier,
          upstreamUrl,
          accountKeyId: step.accountKeyId,
        };
      }
    }

    return {
      ok: true,
      status: response.status,
      latencyMs: config.successBodyBufferBytes > 0 ? performance.now() - started : headerLatency,
      error: null,
      tier: step.tier,
      upstreamUrl,
      accountKeyId: step.accountKeyId,
      response,
      body,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: performance.now() - started,
      error: clip(err?.message || err?.name || err),
      tier: step.tier,
      upstreamUrl,
      accountKeyId: step.accountKeyId,
    };
  }
}

function writeProxyResponseHeaders(upstream, downstream, requestId) {
  downstream.status(upstream.status);
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (DECOMPRESSED_RESPONSE_HEADERS.has(lower)) continue;
    downstream.setHeader(name, value);
  }
  downstream.setHeader("x-proxy-request-id", requestId);
  downstream.setHeader("x-accel-buffering", "no");
  downstream.setHeader("cache-control", "no-store");
  downstream.flushHeaders?.();
}

async function streamUpstreamResponse(upstream, downstream, requestId) {
  if (Buffer.isBuffer(upstream.body)) {
    writeProxyResponseHeaders(upstream.response, downstream, requestId);
    downstream.end(upstream.body);
    return;
  }

  upstream = upstream.response || upstream;
  if (!upstream.body) {
    writeProxyResponseHeaders(upstream, downstream, requestId);
    downstream.end();
    return;
  }

  const reader = upstream.body.getReader();
  let headersWritten = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (!headersWritten) {
        writeProxyResponseHeaders(upstream, downstream, requestId);
        headersWritten = true;
      }
      if (done) break;
      if (!value?.byteLength) continue;
      await writeDownstreamChunk(downstream, value);
    }
    if (!downstream.destroyed && !downstream.writableEnded) downstream.end();
  } finally {
    reader.releaseLock();
  }
}

function writeDownstreamChunk(downstream, chunk) {
  if (downstream.destroyed || downstream.writableEnded) {
    throw new Error("Downstream closed");
  }
  if (downstream.write(Buffer.from(chunk))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      downstream.off("drain", onDrain);
      downstream.off("error", onError);
      downstream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Downstream closed"));
    };
    downstream.once("drain", onDrain);
    downstream.once("error", onError);
    downstream.once("close", onClose);
  });
}

function publicActiveRequest(active) {
  return {
    id: active.id,
    accountId: active.accountId,
    method: active.method,
    path: active.path,
    model: active.model,
    status: active.status,
    startedAt: active.startedAt,
    updatedAt: active.updatedAt,
    attempts: active.attempts,
    current: active.current,
  };
}

export const activeProxyRequests = new Map();

export function getProxyProcessId() {
  return DEFAULT_PROXY_PROCESS_ID;
}

export async function registerProxyProcess({
  query,
  processId = getProxyProcessId(),
  role = "web",
  workerId = null,
} = {}) {
  if (typeof query !== "function") throw new Error("query function is required");
  await query(`
    INSERT INTO proxy_processes (id, hostname, pid, worker_id, role, started_at, last_seen)
    VALUES ($1, $2, $3, $4, $5, now(), now())
    ON CONFLICT (id) DO UPDATE
    SET hostname = EXCLUDED.hostname,
        pid = EXCLUDED.pid,
        worker_id = EXCLUDED.worker_id,
        role = EXCLUDED.role,
        started_at = EXCLUDED.started_at,
        last_seen = EXCLUDED.last_seen
  `, [processId, hostname(), process.pid, workerId == null ? null : String(workerId), role]);
}

export async function heartbeatProxyProcess({
  query,
  processId = getProxyProcessId(),
} = {}) {
  if (typeof query !== "function") throw new Error("query function is required");
  await query(
    `UPDATE proxy_processes SET last_seen = now() WHERE id = $1`,
    [processId]
  );
}

export async function cleanupAbandonedProxyRequests({
  query,
  config = getProxyConfig(),
} = {}) {
  if (typeof query !== "function") throw new Error("query function is required");
  const staleMs = Math.max(0, config.processStaleMs ?? 0);
  const legacyStaleMs = Math.max(0, config.legacyActiveRequestStaleMs ?? 0);
  if (staleMs === 0 && legacyStaleMs === 0) {
    return { ownedClosed: 0, legacyClosed: 0 };
  }

  const { rows } = await query(`
    WITH owned AS (
      UPDATE proxy_requests pr
      SET ok = false,
          final_status = COALESCE(pr.final_status, 499),
          latency_ms = COALESCE(
            pr.latency_ms,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - pr.started_at)) * 1000)
          ),
          error = COALESCE(pr.error, 'Request abandoned by exited server process'),
          completed_at = now()
      WHERE $1::bigint > 0
        AND pr.completed_at IS NULL
        AND pr.proxy_process_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM proxy_processes pp
          WHERE pp.id = pr.proxy_process_id
            AND pp.last_seen >= now() - ($1::bigint * interval '1 millisecond')
        )
      RETURNING 1
    ),
    legacy AS (
      UPDATE proxy_requests pr
      SET ok = false,
          final_status = COALESCE(pr.final_status, 499),
          latency_ms = COALESCE(
            pr.latency_ms,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - pr.started_at)) * 1000)
          ),
          error = COALESCE(pr.error, 'Legacy active request exceeded stale window'),
          completed_at = now()
      WHERE $2::bigint > 0
        AND pr.completed_at IS NULL
        AND pr.proxy_process_id IS NULL
        AND pr.started_at < now() - ($2::bigint * interval '1 millisecond')
      RETURNING 1
    )
    SELECT
      (SELECT count(*)::int FROM owned) AS owned_closed,
      (SELECT count(*)::int FROM legacy) AS legacy_closed
  `, [staleMs, legacyStaleMs]);

  return {
    ownedClosed: rows[0]?.owned_closed ?? 0,
    legacyClosed: rows[0]?.legacy_closed ?? 0,
  };
}

export async function completeCurrentProcessActiveRequests({
  query,
  processId = getProxyProcessId(),
  reason = "Server process stopped before request completed",
} = {}) {
  if (typeof query !== "function") throw new Error("query function is required");
  const { rows } = await query(`
    UPDATE proxy_requests
    SET ok = false,
        final_status = COALESCE(final_status, 499),
        latency_ms = COALESCE(
          latency_ms,
          GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)
        ),
        error = COALESCE(error, $2),
        completed_at = now()
    WHERE proxy_process_id = $1
      AND completed_at IS NULL
    RETURNING id
  `, [processId, reason]);
  return rows.length;
}

export async function startProxyProcessMonitor({
  query,
  config = getProxyConfig(),
  processId = getProxyProcessId(),
  role = "web",
  workerId = null,
} = {}) {
  if (typeof query !== "function") throw new Error("query function is required");

  await registerProxyProcess({ query, processId, role, workerId });
  const initial = await cleanupAbandonedProxyRequests({ query, config });
  if (initial.ownedClosed || initial.legacyClosed) {
    console.log(`[proxy] closed stale active requests owned=${initial.ownedClosed} legacy=${initial.legacyClosed}`);
  }

  const heartbeatMs = Math.max(1_000, config.processHeartbeatMs ?? 30_000);
  const cleanupMs = Math.max(5_000, config.staleCleanupIntervalMs ?? 60_000);
  let stopped = false;

  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    heartbeatProxyProcess({ query, processId }).catch((err) => {
      console.warn("[proxy] process heartbeat failed:", err.message);
    });
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  const cleanupTimer = setInterval(() => {
    if (stopped) return;
    cleanupAbandonedProxyRequests({ query, config })
      .then((result) => {
        if (result.ownedClosed || result.legacyClosed) {
          console.log(`[proxy] closed stale active requests owned=${result.ownedClosed} legacy=${result.legacyClosed}`);
        }
      })
      .catch((err) => {
        console.warn("[proxy] stale active request cleanup failed:", err.message);
      });
  }, cleanupMs);
  cleanupTimer.unref?.();

  return {
    processId,
    async stop({ completeActive = true } = {}) {
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(cleanupTimer);
      if (completeActive) {
        const closed = await completeCurrentProcessActiveRequests({ query, processId });
        if (closed) console.log(`[proxy] closed ${closed} active requests for stopped process`);
      }
      await query(`DELETE FROM proxy_processes WHERE id = $1`, [processId]);
    },
  };
}

async function readThroughCache(cache, key, { ttlMs, maxEntries }, loader) {
  if (ttlMs > 0) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  if (ttlMs > 0) {
    if (!cache.has(key) && cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }

  const pending = Promise.resolve().then(loader);
  if (ttlMs > 0) cache.set(key, { value: pending, expiresAt: Date.now() + ttlMs });
  try {
    const value = await pending;
    if (ttlMs > 0) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  } catch (err) {
    if (ttlMs > 0) cache.delete(key);
    throw err;
  }
}

/* ---------- concurrency semaphore ---------- */
const PROXY_MAX_CONCURRENT = intEnv(process.env, "PROXY_MAX_CONCURRENT", 500);
let proxyActiveCount = 0;
let proxyWaiters = [];

function acquireProxySlot() {
  if (proxyActiveCount < PROXY_MAX_CONCURRENT) {
    proxyActiveCount++;
    return Promise.resolve(releaseProxySlot);
  }
  return new Promise((resolve) => {
    proxyWaiters.push(() => {
      proxyActiveCount++;
      resolve(releaseProxySlot);
    });
  });
}

function releaseProxySlot() {
  proxyActiveCount--;
  const next = proxyWaiters.shift();
  if (next) next();
}

/* ---------- external proxy helpers ---------- */
/**
 * Create a proxy-aware fetch based on proxy URL.
 * Supports socks5://, socks5h://, socks4://, http://, https:// proxy URLs.
 */
function createProxiedFetch(proxyUrl) {
  if (!proxyUrl) return globalThis.fetch;
  try {
    const url = String(proxyUrl).trim();
    if (url.startsWith("socks5h://") || url.startsWith("socks5://") || url.startsWith("socks4://")) {
      const agent = new Socks5ProxyAgent(url);
      return (fetchUrl, fetchOpts = {}) =>
        globalThis.fetch(fetchUrl, { ...fetchOpts, dispatcher: agent });
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const agent = new ProxyAgent(url);
      return (fetchUrl, fetchOpts = {}) =>
        globalThis.fetch(fetchUrl, { ...fetchOpts, dispatcher: agent });
    }
  } catch (err) {
    console.warn("[proxy] failed to create proxy agent for", proxyUrl, err.message);
  }
  return globalThis.fetch;
}

/** Pick a random proxy URL from the list for rotation. */
function pickProxyUrl(proxies) {
  if (!proxies || !proxies.length) return null;
  return proxies[Math.floor(Math.random() * proxies.length)].proxyUrl;
}

export function createPostgresProxyStore({ query, config = getProxyConfig(), processId = getProxyProcessId() }) {
  if (typeof query !== "function") throw new Error("query function is required");
  const cacheOptions = {
    ttlMs: config.accountCacheMs ?? 0,
    maxEntries: Math.max(1, config.accountCacheMax ?? 10000),
  };
  const accountByKeyHashCache = new Map();
  const upstreamKeysByAccountCache = new Map();

  return {
    async isProxyEnabled() {
      const { rows } = await query(
        `SELECT value FROM system_settings WHERE key = 'proxy_enabled'`
      );
      return rows[0]?.value !== "false";
    },

    async findAccountByApiKey(token) {
      const clean = extractAuthorizationToken(token);
      if (!clean) return null;
      const hash = tokenHash(clean);
      return readThroughCache(accountByKeyHashCache, hash, cacheOptions, async () => {
        const { rows } = await query(
          `SELECT id, created_at FROM accounts WHERE api_key_hash = $1`,
          [hash]
        );
        return rows[0] || null;
      });
    },

    async getAccountUpstreamKeys(accountId) {
      return readThroughCache(upstreamKeysByAccountCache, accountId, cacheOptions, async () => {
        const { rows } = await query(`
          SELECT id, tier, priority, enabled, key_ciphertext, created_at
          FROM account_upstream_keys
          WHERE account_id = $1 AND enabled = true
          ORDER BY CASE WHEN tier = 'T2' THEN 0 ELSE 1 END, priority ASC, created_at ASC
        `, [accountId]);
        return rows.map((r) => ({
          id: r.id,
          tier: r.tier,
          priority: r.priority,
          enabled: r.enabled,
          createdAt: r.created_at,
          apiKey: decryptSecret(r.key_ciphertext, config.keySecret),
        }));
      });
    },

    async createProxyRequest(row) {
      await query(`
        INSERT INTO proxy_requests
          (id, account_id, proxy_process_id, method, route_path, request_model, started_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
      `, [row.id, row.accountId, processId, row.method, row.routePath, row.requestModel, row.startedAt]);
    },

    async recordProxyAttempt(row) {
      await query(`
        INSERT INTO proxy_attempts
          (request_id, attempt_no, account_key_id, tier, upstream_url, status, ok, latency_ms, error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        row.requestId,
        row.attemptNo,
        row.accountKeyId,
        row.tier,
        row.upstreamUrl,
        row.status,
        row.ok,
        row.latencyMs,
        row.error,
      ]);
    },

    async completeProxyRequest(row) {
      await query(`
        UPDATE proxy_requests
        SET ok = $2,
            final_status = $3,
            latency_ms = $4,
            attempts = $5,
            upstream_tier = $6,
            upstream_url = $7,
            error = $8,
            streamed = $9,
            completed_at = now()
        WHERE id = $1
      `, [
        row.requestId,
        row.ok,
        row.status,
        row.latencyMs,
        row.attempts,
        row.upstreamTier,
        row.upstreamUrl,
        row.error,
        row.streamed,
      ]);
    },

    async getAccountProxies(accountId) {
      const { rows } = await query(`
        SELECT id, proxy_url, label, enabled, created_at
        FROM account_proxies
        WHERE account_id = $1 AND enabled = true
        ORDER BY created_at ASC
      `, [accountId]);
      return rows.map((r) => ({
        id: r.id,
        proxyUrl: r.proxy_url,
        label: r.label,
        enabled: r.enabled,
        createdAt: r.created_at,
      }));
    },

    async createAccountProxy(accountId, proxyUrl, label = null) {
      const id = randomId("proxy", 8);
      await query(`
        INSERT INTO account_proxies (id, account_id, proxy_url, label, enabled)
        VALUES ($1, $2, $3, $4, true)
      `, [id, accountId, proxyUrl, clip(label, 80) || null]);
      return id;
    },

    async updateAccountProxy(proxyId, accountId, updates) {
      const label = updates.label !== undefined ? (clip(updates.label, 80) || null) : undefined;
      const enabled = updates.enabled !== undefined ? (updates.enabled ? true : false) : undefined;
      const proxyUrl = updates.proxyUrl !== undefined ? updates.proxyUrl : undefined;
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (label !== undefined) { setClauses.push(`label = $${idx++}`); params.push(label); }
      if (enabled !== undefined) { setClauses.push(`enabled = $${idx++}`); params.push(enabled); }
      if (proxyUrl !== undefined) { setClauses.push(`proxy_url = $${idx++}`); params.push(proxyUrl); }
      if (!setClauses.length) return false;
      params.push(proxyId, accountId);
      const { rows } = await query(`
        UPDATE account_proxies SET ${setClauses.join(", ")}
        WHERE id = $${idx++} AND account_id = $${idx++}
        RETURNING id
      `, [...params, proxyId, accountId]);
      return rows.length > 0;
    },

    async deleteAccountProxy(proxyId, accountId) {
      const { rows } = await query(
        'DELETE FROM account_proxies WHERE id = $1 AND account_id = $2 RETURNING id',
        [proxyId, accountId]
      );
      return rows.length > 0;
    },
  };
}

async function completeRequest(store, rowCreated, row) {
  if (!rowCreated) return;
  await store.completeProxyRequest(row);
}

export function createProxyMiddleware({
  store,
  config = getProxyConfig(),
  fetchImpl = globalThis.fetch,
  activeRequests = activeProxyRequests,
  idFactory = () => randomId("prx"),
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error("proxy store is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  return async function proxyHandler(req, res) {
    const release = await acquireProxySlot();
    try {
      req.setTimeout?.(0);
      res.setTimeout?.(0);
      res.socket?.setTimeout?.(0);

    const requestId = idFactory();
    const startedAt = now();
    const startedPerf = performance.now();
    const path = proxyPathFromRequest(req);
    const rawBody = rawBodyFromRequest(req);
    const requestModel = extractRequestModel(rawBody, req.get("content-type"));
    const active = {
      id: requestId,
      accountId: null,
      method: req.method,
      path,
      model: requestModel,
      status: "starting",
      startedAt,
      updatedAt: startedAt,
      attempts: [],
      current: null,
    };

    let rowCreated = false;
    let attemptNo = 0;
    let lastAttempt = null;
    const downstreamAbort = new AbortController();

    res.on("close", () => {
      if (!res.writableEnded && !downstreamAbort.signal.aborted) {
        downstreamAbort.abort(new Error("Downstream closed"));
      }
    });

    const touch = (status, current = active.current) => {
      active.status = status;
      active.current = current;
      active.updatedAt = now();
      activeRequests.set(requestId, publicActiveRequest(active));
    };

    const complete = async (update) => {
      await completeRequest(store, rowCreated, {
        requestId,
        ok: update.ok,
        status: update.status,
        latencyMs: performance.now() - startedPerf,
        attempts: attemptNo,
        upstreamTier: update.upstreamTier || null,
        upstreamUrl: update.upstreamUrl || null,
        error: update.error || null,
        streamed: !!update.streamed,
      });
    };

    const throwIfDownstreamClosed = () => {
      if (downstreamAbort.signal.aborted) {
        throw downstreamAbort.signal.reason || new Error("Downstream closed");
      }
    };

    try {
      touch("starting");
      const inboundToken = extractAuthorizationToken(req.get("authorization"));
      const account = inboundToken ? await store.findAccountByApiKey(inboundToken) : null;
      active.accountId = account?.id || null;
      const activeProxies = account?.id
        ? (await store.getAccountProxies(account.id).catch(() => []))
        : [];

      await store.createProxyRequest({
        id: requestId,
        accountId: active.accountId,
        method: req.method,
        routePath: path,
        requestModel,
        startedAt,
      });
      rowCreated = true;

      if (!(await store.isProxyEnabled())) {
        touch("disabled", null);
        await complete({ ok: false, status: 503, error: "Proxy disabled" });
        res.status(503).set("cache-control", "no-store").json({
          error: "proxy_disabled",
          requestId,
        });
        return;
      }

      let plan;
      if (account) {
        const keys = await store.getAccountUpstreamKeys(account.id);
        plan = buildAccountAttemptPlan(keys, config);
        if (!plan.length) {
          touch("no_upstream_keys", null);
          await complete({ ok: false, status: 400, error: "Account has no enabled upstream API keys" });
          res.status(400).set("cache-control", "no-store").json({
            error: "no_upstream_keys",
            requestId,
          });
          return;
        }
      } else {
        plan = buildDirectAttemptPlan(inboundToken, config);
      }

      for (const step of plan) {
        for (let i = 0; i < step.maxAttempts; i++) {
          throwIfDownstreamClosed();
          attemptNo += 1;
          touch("attempting", {
            attemptNo,
            tier: step.tier,
            upstreamUrl: step.upstreamBaseUrl,
            accountKeyId: step.accountKeyId,
          });

          const proxyUrl = pickProxyUrl(activeProxies);
          const attemptFetch = proxyUrl ? createProxiedFetch(proxyUrl) : fetchImpl;

          const attempt = await fetchAttempt({
            req,
            rawBody,
            path,
            step,
            fetchImpl: attemptFetch,
            config,
            signal: downstreamAbort.signal,
          });
          lastAttempt = attempt;
          throwIfDownstreamClosed();

          const attemptPublic = {
            attemptNo,
            tier: attempt.tier,
            upstreamUrl: attempt.upstreamUrl,
            accountKeyId: attempt.accountKeyId,
            status: attempt.status,
            ok: attempt.ok,
            latencyMs: Math.round(attempt.latencyMs),
            error: attempt.error,
          };
          active.attempts.push(attemptPublic);
          touch(attempt.ok ? "streaming" : "retrying", attemptPublic);

          await store.recordProxyAttempt({
            requestId,
            attemptNo,
            accountKeyId: attempt.accountKeyId,
            tier: attempt.tier,
            upstreamUrl: attempt.upstreamUrl,
            status: attempt.status,
            ok: attempt.ok,
            latencyMs: attempt.latencyMs,
            error: attempt.error,
          });

          if (attempt.ok) {
            try {
              await streamUpstreamResponse(attempt, res, requestId);
              await complete({
                ok: true,
                status: attempt.status,
                upstreamTier: attempt.tier,
                upstreamUrl: attempt.upstreamUrl,
                streamed: true,
              });
              touch("completed", attemptPublic);
            } catch (err) {
              const message = clip(err?.message || err?.name || err);
              await complete({
                ok: false,
                status: attempt.status || 502,
                upstreamTier: attempt.tier,
                upstreamUrl: attempt.upstreamUrl,
                error: message,
                streamed: true,
              });
              touch("stream_error", attemptPublic);
              if (!res.headersSent) {
                res.status(502).set("cache-control", "no-store").json({
                  error: "upstream_stream_error",
                  requestId,
                });
              } else if (!res.writableEnded && !res.destroyed) {
                res.destroy(err);
              }
            }
            return;
          }
        }
      }

      const status = lastAttempt?.status || 502;
      const error = lastAttempt?.error || "All upstream attempts failed";
      await complete({
        ok: false,
        status,
        upstreamTier: lastAttempt?.tier || null,
        upstreamUrl: lastAttempt?.upstreamUrl || null,
        error,
      });
      touch("failed", lastAttempt ? {
        attemptNo,
        tier: lastAttempt.tier,
        upstreamUrl: lastAttempt.upstreamUrl,
        status,
        ok: false,
        error,
      } : null);
      res.status(502).set("cache-control", "no-store").json({
        error: "upstream_failed",
        requestId,
        attempts: attemptNo,
      });
    } catch (err) {
      const message = clip(err?.message || err?.name || err);
      const downstreamClosed = downstreamAbort.signal.aborted;
      if (downstreamClosed) {
        touch("client_closed", { error: message });
        try {
          await complete({ ok: false, status: 499, error: message || "Downstream closed" });
        } catch (completeErr) {
          console.warn("[proxy] failed to record client close:", completeErr.message);
        }
        return;
      }

      touch("error", { error: message });
      try {
        await complete({ ok: false, status: 500, error: message });
      } catch (completeErr) {
        console.warn("[proxy] failed to record request error:", completeErr.message);
      }
      if (!res.headersSent) {
        res.status(500).set("cache-control", "no-store").json({
          error: "proxy_error",
          requestId,
        });
      } else {
        res.end();
      }
    } finally {
      activeRequests.delete(requestId);
    }
    } finally {
      release();
    }
  };
}

export function registerProxyRoutes(app, { query, config = getProxyConfig(), fetchImpl } = {}) {
  const store = createPostgresProxyStore({ query, config });
  const middleware = createProxyMiddleware({ store, config, fetchImpl });
  const raw = express.raw({ type: "*/*", limit: config.bodyLimit });

  app.all("/v1/*", raw, middleware);
  app.all("/proxy/v1/*", raw, middleware);

  return { store, config };
}

async function accountPayload(accountId, query) {
  const { rows: accountRows } = await query(
    `SELECT id, created_at FROM accounts WHERE id = $1`,
    [accountId]
  );
  const account = accountRows[0];
  if (!account) return null;

  const { rows: keyRows } = await query(`
    SELECT id, label, tier, priority, enabled, key_hint, created_at
    FROM account_upstream_keys
    WHERE account_id = $1
    ORDER BY CASE WHEN tier = 'T2' THEN 0 ELSE 1 END, priority ASC, created_at ASC
  `, [accountId]);

  return {
    id: account.id,
    createdAt: account.created_at,
    keys: keyRows.map((key) => ({
      id: key.id,
      label: key.label,
      tier: key.tier,
      priority: key.priority,
      enabled: key.enabled,
      keyHint: key.key_hint,
      createdAt: key.created_at,
    })),
  };
}

function adminTokenFromRequest(req) {
  return (
    req.get("x-admin-token") ||
    extractAuthorizationToken(req.get("authorization")) ||
    String(req.query?.token || "")
  ).trim();
}

function requireAdmin(config) {
  return (req, res, next) => {
    if (!config.adminToken) {
      res.status(503).json({ error: "admin_not_configured" });
      return;
    }
    if (!secureEqual(adminTokenFromRequest(req), config.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createAdminAuth(config = getProxyConfig()) {
  return requireAdmin(config);
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|1|yes|on)$/i.test(value)) return true;
    if (/^(false|0|no|off)$/i.test(value)) return false;
  }
  return null;
}

function proxyRequestRow(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    method: row.method,
    path: row.route_path,
    model: row.request_model,
    ok: row.ok,
    status: row.final_status,
    latencyMs: row.latency_ms == null ? null : Math.round(Number(row.latency_ms)),
    attempts: row.attempts,
    upstreamTier: row.upstream_tier,
    upstreamUrl: row.upstream_url,
    error: row.error,
    streamed: row.streamed,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function activeProxyRequestRow(row) {
  const request = proxyRequestRow(row);
  return {
    ...request,
    status: "active",
    current: null,
  };
}

function successRate(ok, total) {
  return total ? +((ok / total) * 100).toFixed(2) : null;
}

function usageSummaryRow(row) {
  const total = row?.total ?? 0;
  const ok = row?.ok ?? 0;
  return {
    total,
    ok,
    failed: row?.failed ?? Math.max(0, total - ok),
    successRate: successRate(ok, total),
    avgLatencyMs: row?.avg_latency_ms == null ? null : Math.round(Number(row.avg_latency_ms)),
  };
}

async function accountUsagePayload(accountId, query, config = getProxyConfig()) {
  const { rows: accountRows } = await query(
    `SELECT id FROM accounts WHERE id = $1`,
    [accountId]
  );
  if (!accountRows.length) return null;

  const officialT2Target = config.targets?.T2 || "https://api-cc.freemodel.dev";
  const officialT0Target = config.targets?.T0 || "https://cc.freemodel.dev";

  const { rows: summaryRows } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ok = true)::int AS ok,
           count(*) FILTER (WHERE ok = false)::int AS failed,
           avg(latency_ms)::float8 AS avg_latency_ms,
           avg(attempts)::float8 AS avg_attempts,
           max(completed_at) AS last_completed_at
    FROM proxy_requests
    WHERE account_id = $1
      AND completed_at IS NOT NULL
      AND completed_at > now() - interval '24 hours'
  `, [accountId]);
  const summary = summaryRows[0] || {};
  const total = summary.total ?? 0;
  const ok = summary.ok ?? 0;
  const failed = summary.failed ?? Math.max(0, total - ok);

  const { rows: byStatusRows } = await query(`
    SELECT COALESCE(final_status, 0)::int AS status,
           count(*)::int AS total,
           count(*) FILTER (WHERE ok = true)::int AS ok
    FROM proxy_requests
    WHERE account_id = $1
      AND completed_at IS NOT NULL
      AND completed_at > now() - interval '24 hours'
    GROUP BY 1
    ORDER BY total DESC, status ASC
    LIMIT 8
  `, [accountId]);

  const { rows: byModelRows } = await query(`
    SELECT COALESCE(request_model, 'unknown') AS model,
           count(*)::int AS total,
           count(*) FILTER (WHERE ok = true)::int AS ok,
           avg(latency_ms)::float8 AS avg_latency_ms
    FROM proxy_requests
    WHERE account_id = $1
      AND completed_at IS NOT NULL
      AND completed_at > now() - interval '24 hours'
    GROUP BY 1
    ORDER BY total DESC, model ASC
    LIMIT 8
  `, [accountId]);

  const { rows: bucketRows } = await query(`
    WITH bucket_series AS (
      SELECT generate_series(
        date_trunc('hour', now() - interval '23 hours'),
        date_trunc('hour', now()),
        interval '1 hour'
      ) AS bucket
    ),
    agg AS (
      SELECT date_trunc('hour', completed_at) AS bucket,
             count(*)::int AS total,
             count(*) FILTER (WHERE ok = true)::int AS ok,
             count(*) FILTER (WHERE ok = false)::int AS failed,
             avg(latency_ms)::float8 AS avg_latency_ms
      FROM proxy_requests
      WHERE account_id = $1
        AND completed_at IS NOT NULL
        AND completed_at > now() - interval '24 hours'
      GROUP BY 1
    )
    SELECT EXTRACT(EPOCH FROM b.bucket) * 1000 AS bucket_ms,
           COALESCE(a.total, 0)::int AS total,
           COALESCE(a.ok, 0)::int AS ok,
           COALESCE(a.failed, 0)::int AS failed,
           a.avg_latency_ms
    FROM bucket_series b
    LEFT JOIN agg a ON a.bucket = b.bucket
    ORDER BY b.bucket ASC
  `, [accountId]);

  const { rows: officialRows } = await query(`
    SELECT target,
           count(*)::int AS total,
           count(*) FILTER (WHERE ok = true)::int AS ok,
           count(*) FILTER (WHERE ok = false)::int AS failed,
           avg(latency_ms)::float8 AS avg_latency_ms
    FROM probes
    WHERE target IN ($1, $2)
      AND ts > now() - interval '24 hours'
    GROUP BY target
  `, [officialT2Target, officialT0Target]);
  const officialByTarget = new Map(officialRows.map((row) => [row.target, row]));

  return {
    accountId,
    windowHours: 24,
    generatedAt: Date.now(),
    summary: {
      total,
      ok,
      failed,
      successRate: successRate(ok, total),
      avgLatencyMs: summary.avg_latency_ms == null ? null : Math.round(Number(summary.avg_latency_ms)),
      avgAttempts: summary.avg_attempts == null ? null : +Number(summary.avg_attempts).toFixed(2),
      lastCompletedAt: summary.last_completed_at,
    },
    official: {
      t2: { target: officialT2Target, ...usageSummaryRow(officialByTarget.get(officialT2Target)) },
      t0: { target: officialT0Target, ...usageSummaryRow(officialByTarget.get(officialT0Target)) },
    },
    byStatus: byStatusRows.map((row) => ({
      status: row.status,
      total: row.total,
      ok: row.ok,
      failed: Math.max(0, row.total - row.ok),
      successRate: successRate(row.ok, row.total),
    })),
    byModel: byModelRows.map((row) => ({
      model: row.model,
      total: row.total,
      ok: row.ok,
      failed: Math.max(0, row.total - row.ok),
      successRate: successRate(row.ok, row.total),
      avgLatencyMs: row.avg_latency_ms == null ? null : Math.round(Number(row.avg_latency_ms)),
    })),
    buckets: bucketRows.map((row) => {
      const total = row.total ?? 0;
      const ok = row.ok ?? 0;
      return {
        ts: Number(row.bucket_ms),
        total,
        ok,
        failed: row.failed ?? Math.max(0, total - ok),
        successRate: successRate(ok, total),
        avgLatencyMs: row.avg_latency_ms == null ? null : Math.round(Number(row.avg_latency_ms)),
      };
    }),
  };
}

export function registerAccountAndAdminRoutes(app, { query, config = getProxyConfig() } = {}) {
  if (typeof query !== "function") throw new Error("query function is required");
  const admin = requireAdmin(config);
  const store = createPostgresProxyStore({ query, config });

  app.post("/api/accounts", async (_req, res) => {
    try {
      const id = randomId("acct", 12);
      const apiKey = randomId("fmk", 32);
      await query(
        `INSERT INTO accounts (id, api_key_hash) VALUES ($1, $2)`,
        [id, tokenHash(apiKey)]
      );
      const account = await accountPayload(id, query);
      res.status(201).json({ account, apiKey });
    } catch (err) {
      console.error("[accounts] create failed:", err);
      res.status(500).json({ error: "account_create_failed" });
    }
  });

  app.get("/api/accounts/:accountId", async (req, res) => {
    try {
      const account = await accountPayload(req.params.accountId, query);
      if (!account) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }
      res.json({ account });
    } catch (err) {
      res.status(500).json({ error: "account_load_failed" });
    }
  });

  app.get("/api/accounts/:accountId/usage", async (req, res) => {
    try {
      const payload = await accountUsagePayload(req.params.accountId, query, config);
      if (!payload) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }
      res.set("cache-control", "no-store");
      res.json(payload);
    } catch (err) {
      console.error("[accounts] usage load failed:", err);
      res.status(500).json({ error: "account_usage_load_failed" });
    }
  });

  app.delete("/api/accounts/:accountId", async (req, res) => {
    try {
      const { rows } = await query(
        `DELETE FROM accounts WHERE id = $1 RETURNING id`,
        [req.params.accountId]
      );
      if (!rows.length) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "account_delete_failed" });
    }
  });

  app.post("/api/accounts/:accountId/api-key", async (req, res) => {
    try {
      const apiKey = randomId("fmk", 32);
      const { rows } = await query(
        `UPDATE accounts SET api_key_hash = $2 WHERE id = $1 RETURNING id`,
        [req.params.accountId, tokenHash(apiKey)]
      );
      if (!rows.length) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }
      res.json({ apiKey });
    } catch (err) {
      res.status(500).json({ error: "api_key_rotate_failed" });
    }
  });

  app.post("/api/accounts/:accountId/keys", async (req, res) => {
    try {
      const account = await accountPayload(req.params.accountId, query);
      if (!account) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }

      const apiKey = extractAuthorizationToken(req.body?.apiKey);
      const tier = normalizeTier(req.body?.tier);
      if (!apiKey || !tier) {
        res.status(400).json({ error: "invalid_key" });
        return;
      }

      const id = randomId("key", 12);
      await query(`
        INSERT INTO account_upstream_keys
          (id, account_id, label, tier, priority, enabled, key_hash, key_hint, key_ciphertext)
        VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
      `, [
        id,
        req.params.accountId,
        sanitizeLabel(req.body?.label),
        tier,
        normalizePriority(req.body?.priority),
        tokenHash(apiKey),
        keyHint(apiKey),
        encryptSecret(apiKey, config.keySecret),
      ]);
      res.status(201).json({ account: await accountPayload(req.params.accountId, query) });
    } catch (err) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "duplicate_key" });
        return;
      }
      console.error("[accounts] key add failed:", err);
      res.status(500).json({ error: "key_add_failed" });
    }
  });

  app.patch("/api/accounts/:accountId/keys/:keyId", async (req, res) => {
    try {
      const tier = req.body?.tier == null ? null : normalizeTier(req.body.tier);
      const priority = req.body?.priority == null ? null : normalizePriority(req.body.priority);
      const enabled = req.body?.enabled == null ? null : parseBoolean(req.body.enabled);
      const label = req.body?.label == null ? null : sanitizeLabel(req.body.label);
      if (req.body?.tier != null && !tier) {
        res.status(400).json({ error: "invalid_tier" });
        return;
      }
      if (req.body?.enabled != null && enabled == null) {
        res.status(400).json({ error: "invalid_enabled" });
        return;
      }

      const { rows } = await query(`
        UPDATE account_upstream_keys
        SET label = COALESCE($3, label),
            tier = COALESCE($4, tier),
            priority = COALESCE($5, priority),
            enabled = COALESCE($6, enabled)
        WHERE account_id = $1 AND id = $2
        RETURNING id
      `, [req.params.accountId, req.params.keyId, label, tier, priority, enabled]);
      if (!rows.length) {
        res.status(404).json({ error: "key_not_found" });
        return;
      }
      res.json({ account: await accountPayload(req.params.accountId, query) });
    } catch (err) {
      res.status(500).json({ error: "key_update_failed" });
    }
  });

  app.delete("/api/accounts/:accountId/keys/:keyId", async (req, res) => {
    try {
      const { rows } = await query(
        `DELETE FROM account_upstream_keys WHERE account_id = $1 AND id = $2 RETURNING id`,
        [req.params.accountId, req.params.keyId]
      );
      if (!rows.length) {
        res.status(404).json({ error: "key_not_found" });
        return;
      }
      res.json({ account: await accountPayload(req.params.accountId, query) });
    } catch (err) {
      res.status(500).json({ error: "key_delete_failed" });
    }
  });

  /* ---------- external proxy management ---------- */
  app.get("/api/accounts/:accountId/proxies", async (req, res) => {
    try {
      const proxies = await store.getAccountProxies(req.params.accountId);
      res.json({ proxies });
    } catch (err) {
      res.status(500).json({ error: "proxies_load_failed" });
    }
  });

  app.post("/api/accounts/:accountId/proxies", async (req, res) => {
    try {
      const proxyUrl = String(req.body?.proxyUrl || "").trim();
      if (!proxyUrl) {
        res.status(400).json({ error: "proxy_url_required" });
        return;
      }
      if (!/^(socks5h?:\/\/|socks4:\/\/|https?:\/\/)/i.test(proxyUrl)) {
        res.status(400).json({ error: "invalid_proxy_url_format" });
        return;
      }
      const id = await store.createAccountProxy(req.params.accountId, proxyUrl, req.body?.label);
      const proxies = await store.getAccountProxies(req.params.accountId);
      res.status(201).json({ proxyId: id, proxies });
    } catch (err) {
      res.status(500).json({ error: "proxy_add_failed" });
    }
  });

  app.patch("/api/accounts/:accountId/proxies/:proxyId", async (req, res) => {
    try {
      const ok = await store.updateAccountProxy(req.params.proxyId, req.params.accountId, {
        label: req.body?.label,
        enabled: req.body?.enabled,
        proxyUrl: req.body?.proxyUrl,
      });
      if (!ok) {
        res.status(404).json({ error: "proxy_not_found" });
        return;
      }
      const proxies = await store.getAccountProxies(req.params.accountId);
      res.json({ proxies });
    } catch (err) {
      res.status(500).json({ error: "proxy_update_failed" });
    }
  });

  app.delete("/api/accounts/:accountId/proxies/:proxyId", async (req, res) => {
    try {
      const ok = await store.deleteAccountProxy(req.params.proxyId, req.params.accountId);
      if (!ok) {
        res.status(404).json({ error: "proxy_not_found" });
        return;
      }
      const proxies = await store.getAccountProxies(req.params.accountId);
      res.json({ proxies });
    } catch (err) {
      res.status(500).json({ error: "proxy_delete_failed" });
    }
  });

  app.get("/api/admin/overview", admin, async (req, res) => {
    try {
      await cleanupAbandonedProxyRequests({ query, config }).catch((err) => {
        console.warn("[admin] stale active request cleanup failed:", err.message);
      });
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "80", 10)));
      const [{ rows: settingRows }, { rows: activeRows }, { rows: recentRows }, { rows: totalRows }, { rows: byStatusRows }, { rows: byTierRows }, { rows: accountRows }] = await Promise.all([
        query(`SELECT value FROM system_settings WHERE key = 'proxy_enabled'`),
        query(`
          SELECT id, account_id, method, route_path, request_model, ok, final_status,
                 latency_ms, attempts, upstream_tier, upstream_url, error,
                 streamed, started_at, completed_at
          FROM proxy_requests
          WHERE completed_at IS NULL
          ORDER BY started_at DESC
          LIMIT 100
        `),
        query(`
          SELECT id, account_id, method, route_path, request_model, ok, final_status,
                 latency_ms, attempts, upstream_tier, upstream_url, error,
                 streamed, started_at, completed_at
          FROM proxy_requests
          ORDER BY started_at DESC
          LIMIT $1
        `, [limit]),
        query(`
          SELECT count(*)::int AS requests,
                 count(*) FILTER (WHERE ok = true)::int AS ok,
                 count(*) FILTER (WHERE ok = false)::int AS failed,
                 avg(latency_ms)::float8 AS avg_latency_ms
          FROM proxy_requests
          WHERE started_at > now() - interval '24 hours'
        `),
        query(`
          SELECT COALESCE(final_status, 0)::int AS status, count(*)::int AS requests
          FROM proxy_requests
          WHERE started_at > now() - interval '24 hours'
          GROUP BY 1
          ORDER BY requests DESC, status ASC
        `),
        query(`
          SELECT COALESCE(upstream_tier, 'none') AS tier, count(*)::int AS requests
          FROM proxy_requests
          WHERE started_at > now() - interval '24 hours'
          GROUP BY 1
          ORDER BY requests DESC, tier ASC
        `),
        query(`
          WITH key_counts AS (
            SELECT account_id,
                   count(*)::int AS keys,
                   count(*) FILTER (WHERE enabled)::int AS enabled_keys
            FROM account_upstream_keys
            GROUP BY account_id
          ),
          request_counts AS (
            SELECT account_id,
                   count(*)::int AS requests,
                   max(started_at) AS last_request_at
            FROM proxy_requests
            WHERE account_id IS NOT NULL
            GROUP BY account_id
          )
          SELECT a.id, a.created_at,
                 COALESCE(k.keys, 0)::int AS keys,
                 COALESCE(k.enabled_keys, 0)::int AS enabled_keys,
                 COALESCE(r.requests, 0)::int AS requests,
                 r.last_request_at
          FROM accounts a
          LEFT JOIN key_counts k ON k.account_id = a.id
          LEFT JOIN request_counts r ON r.account_id = a.id
          ORDER BY a.created_at DESC
          LIMIT 100
        `),
      ]);

      const localActive = [...activeProxyRequests.values()];
      const localActiveIds = new Set(localActive.map((row) => row.id));
      res.set("cache-control", "no-store");
      res.json({
        generatedAt: Date.now(),
        system: {
          proxyEnabled: settingRows[0]?.value !== "false",
          adminConfigured: !!config.adminToken,
        },
        active: [
          ...localActive,
          ...activeRows.map(activeProxyRequestRow).filter((row) => !localActiveIds.has(row.id)),
        ],
        recent: recentRows.map(proxyRequestRow),
        totals24h: {
          requests: totalRows[0]?.requests ?? 0,
          ok: totalRows[0]?.ok ?? 0,
          failed: totalRows[0]?.failed ?? 0,
          avgLatencyMs: totalRows[0]?.avg_latency_ms == null ? null : Math.round(Number(totalRows[0].avg_latency_ms)),
        },
        byStatus: byStatusRows,
        byTier: byTierRows,
        accounts: accountRows.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          keys: row.keys,
          enabledKeys: row.enabled_keys,
          requests: row.requests,
          lastRequestAt: row.last_request_at,
        })),
      });
    } catch (err) {
      console.error("[admin] overview failed:", err);
      res.status(500).json({ error: "admin_overview_failed" });
    }
  });

  app.patch("/api/admin/system", admin, async (req, res) => {
    try {
      const enabled = parseBoolean(req.body?.proxyEnabled);
      if (enabled == null) {
        res.status(400).json({ error: "invalid_proxy_enabled" });
        return;
      }
      await query(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('proxy_enabled', $1, now())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `, [enabled ? "true" : "false"]);
      res.json({ system: { proxyEnabled: enabled } });
    } catch (err) {
      res.status(500).json({ error: "admin_system_update_failed" });
    }
  });

  app.get("/api/admin/requests/:requestId", admin, async (req, res) => {
    try {
      const { rows: requestRows } = await query(`
        SELECT id, account_id, method, route_path, request_model, ok, final_status,
               latency_ms, attempts, upstream_tier, upstream_url, error,
               streamed, started_at, completed_at
        FROM proxy_requests
        WHERE id = $1
      `, [req.params.requestId]);
      if (!requestRows.length) {
        res.status(404).json({ error: "request_not_found" });
        return;
      }
      const { rows: attemptRows } = await query(`
        SELECT attempt_no, account_key_id, tier, upstream_url, status, ok,
               latency_ms, error, ts
        FROM proxy_attempts
        WHERE request_id = $1
        ORDER BY attempt_no ASC
      `, [req.params.requestId]);
      res.json({
        request: proxyRequestRow(requestRows[0]),
        attempts: attemptRows.map((row) => ({
          attemptNo: row.attempt_no,
          accountKeyId: row.account_key_id,
          tier: row.tier,
          upstreamUrl: row.upstream_url,
          status: row.status,
          ok: row.ok,
          latencyMs: Math.round(Number(row.latency_ms)),
          error: row.error,
          ts: row.ts,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "admin_request_load_failed" });
    }
  });

  app.delete("/api/admin/accounts/:accountId", admin, async (req, res) => {
    try {
      const { rows } = await query(
        `DELETE FROM accounts WHERE id = $1 RETURNING id`,
        [req.params.accountId]
      );
      if (!rows.length) {
        res.status(404).json({ error: "account_not_found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "admin_account_delete_failed" });
    }
  });
}
