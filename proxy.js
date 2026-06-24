import express from "express";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_TARGETS = {
  T2: "https://api-cc.freemodel.dev",
  T0: "https://cc.freemodel.dev",
};

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

const normalizeBaseUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

export function getProxyConfig(env = process.env) {
  return {
    targets: {
      T2: normalizeBaseUrl(env.PROXY_T2_URL || DEFAULT_TARGETS.T2),
      T0: normalizeBaseUrl(env.PROXY_T0_URL || DEFAULT_TARGETS.T0),
    },
    retriesPerCredential: intEnv(env, "PROXY_RETRIES_PER_CREDENTIAL", 10),
    bodyLimit: env.PROXY_BODY_LIMIT || "20mb",
    failureBodyDrainBytes: intEnv(env, "PROXY_FAILURE_DRAIN_BYTES", 64 * 1024),
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
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value == null) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  const authorization = bearerHeader(token);
  if (authorization) headers.authorization = authorization;
  else delete headers.authorization;

  headers.accept = headers.accept || "application/json";
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

async function fetchAttempt({ req, rawBody, path, step, fetchImpl, config }) {
  const upstreamUrl = new URL(path, step.upstreamBaseUrl).toString();
  const started = performance.now();
  try {
    const options = {
      method: req.method,
      headers: buildUpstreamHeaders(req, step.token),
      redirect: "manual",
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

    return {
      ok: true,
      status: response.status,
      latencyMs: headerLatency,
      error: null,
      tier: step.tier,
      upstreamUrl,
      accountKeyId: step.accountKeyId,
      response,
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
    downstream.setHeader(name, value);
  }
  downstream.setHeader("x-proxy-request-id", requestId);
  downstream.setHeader("x-accel-buffering", "no");
  downstream.setHeader("cache-control", "no-store");
  downstream.flushHeaders?.();
}

async function streamUpstreamResponse(upstream, downstream, requestId) {
  writeProxyResponseHeaders(upstream, downstream, requestId);
  if (!upstream.body) {
    downstream.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body), downstream);
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

export function createPostgresProxyStore({ query, config = getProxyConfig() }) {
  if (typeof query !== "function") throw new Error("query function is required");

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
      const { rows } = await query(
        `SELECT id, created_at FROM accounts WHERE api_key_hash = $1`,
        [tokenHash(clean)]
      );
      return rows[0] || null;
    },

    async getAccountUpstreamKeys(accountId) {
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
    },

    async createProxyRequest(row) {
      await query(`
        INSERT INTO proxy_requests
          (id, account_id, method, route_path, request_model, started_at)
        VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
      `, [row.id, row.accountId, row.method, row.routePath, row.requestModel, row.startedAt]);
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

    try {
      touch("starting");
      const inboundToken = extractAuthorizationToken(req.get("authorization"));
      const account = inboundToken ? await store.findAccountByApiKey(inboundToken) : null;
      active.accountId = account?.id || null;

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
          attemptNo += 1;
          touch("attempting", {
            attemptNo,
            tier: step.tier,
            upstreamUrl: step.upstreamBaseUrl,
            accountKeyId: step.accountKeyId,
          });

          const attempt = await fetchAttempt({
            req,
            rawBody,
            path,
            step,
            fetchImpl,
            config,
          });
          lastAttempt = attempt;

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
              await streamUpstreamResponse(attempt.response, res, requestId);
              await complete({
                ok: true,
                status: attempt.status,
                upstreamTier: attempt.tier,
                upstreamUrl: attempt.upstreamUrl,
                streamed: true,
              });
              touch("completed", attemptPublic);
            } catch (err) {
              await complete({
                ok: false,
                status: attempt.status || 502,
                upstreamTier: attempt.tier,
                upstreamUrl: attempt.upstreamUrl,
                error: clip(err?.message || err?.name || err),
                streamed: true,
              });
              touch("stream_error", attemptPublic);
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

export function registerAccountAndAdminRoutes(app, { query, config = getProxyConfig() } = {}) {
  if (typeof query !== "function") throw new Error("query function is required");
  const admin = requireAdmin(config);

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

  app.get("/api/admin/overview", admin, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "80", 10)));
      const [{ rows: settingRows }, { rows: recentRows }, { rows: totalRows }, { rows: byStatusRows }, { rows: byTierRows }, { rows: accountRows }] = await Promise.all([
        query(`SELECT value FROM system_settings WHERE key = 'proxy_enabled'`),
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

      res.set("cache-control", "no-store");
      res.json({
        system: {
          proxyEnabled: settingRows[0]?.value !== "false",
          adminConfigured: !!config.adminToken,
        },
        active: [...activeProxyRequests.values()],
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
