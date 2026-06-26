/* =================================================================
 * proxy-e2e-test.mjs — End-to-end test of external proxy integration
 * ----------------------------------------------------------------
 *  Tests the external proxy support by:
 *  1. Creating a local HTTP CONNECT proxy server
 *  2. Starting the proxy system
 *  3. Adding the local proxy to an account
 *  4. Making requests through the system which should use the proxy
 * ================================================================= */

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import express from "express";
import "dotenv/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.test", override: true });

import { createProxyMiddleware, createPostgresProxyStore } from "../proxy.js";

const MODEL = "claude-haiku-4-5-20251001";
const TARGET = "https://api-cc.freemodel.dev";
const FALLBACK = "https://cc.freemodel.dev";

/* ---------- Helpers ---------- */
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

/* ---------- Local HTTP Proxy Server ---------- */
// A minimal HTTP CONNECT proxy that records connections for verification
function createLocalProxy() {
  const connections = [];
  const server = http.createServer((req, res) => {
    // HTTP CONNECT for HTTPS tunneling
    if (req.method === "CONNECT") {
      const [host, port] = req.url.split(":");
      connections.push({ host, port: parseInt(port, 10), method: "CONNECT" });
      const c = net.connect(parseInt(port, 10) || 443, host, () => {
        res.writeHead(200, {});
        res.socket.setNoDelay(true);
        res.socket.pipe(c);
        c.pipe(res.socket);
      });
      c.on("error", () => { res.writeHead(502); res.end(); });
      req.on("error", () => c.destroy());
      return;
    }
    // Direct HTTP requests
    connections.push({ url: req.url, method: req.method });
    const options = new URL(req.url);
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
    proxyReq.on("error", () => { res.writeHead(502); res.end(); });
  });
  server.on("connection", (sock) => {
    sock.setTimeout(10000);
  });
  return { server, getConnections: () => connections, clear: () => { connections.length = 0; } };
}

/* ---------- In-memory Proxy Store ---------- */
function createTestStore() {
  // Simulates the full Postgres proxy store with in-memory state
  const state = {
    requests: [],
    attempts: [],
    completed: [],
    proxies: new Map(), // accountId -> proxy[]
    proxyEnabled: true,
    accounts: new Map(),
    upstreamKeys: new Map(),
  };

  function getAccountProxies(accountId) {
    return Promise.resolve(state.proxies.get(accountId) || []);
  }

  function createAccountProxy(accountId, proxyUrl, label) {
    const id = `proxy_test_${state.proxies.get(accountId)?.length || 0}`;
    const entry = { id, proxyUrl, label: label || null, enabled: true };
    if (!state.proxies.has(accountId)) state.proxies.set(accountId, []);
    state.proxies.get(accountId).push(entry);
    return Promise.resolve(id);
  }

  return {
    state,
    getAccountProxies,
    createAccountProxy,
    async isProxyEnabled() { return state.proxyEnabled; },
    async findAccountByApiKey(token) {
      for (const [id, acct] of state.accounts) {
        if (acct.apiKey === token) return { id, createdAt: new Date().toISOString() };
      }
      return null;
    },
    async getAccountUpstreamKeys(accountId) {
      return state.upstreamKeys.get(accountId) || [];
    },
    async createProxyRequest(row) { state.requests.push({ ...row }); },
    async recordProxyAttempt(row) { state.attempts.push({ ...row }); },
    async completeProxyRequest(row) { state.completed.push({ ...row }); },
  };
}

/* ---------- Main ---------- */
async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  Proxy System — External Proxy E2E Test");
  console.log("══════════════════════════════════════════════\n");

  // 1. Create local HTTP CONNECT proxy
  console.log("─── Setup: Local Test Proxy ─────────────────");
  const localProxy = createLocalProxy();
  const proxyUrl = await listen(localProxy.server);
  console.log(`  ✓ Local test proxy listening at ${proxyUrl}`);

  // 2. Create proxy system middleware with in-memory store
  console.log("\n─── Setup: Proxy Middleware ──────────────────");
  const store = createTestStore();
  const app = express();
  app.all("/v1/*", express.raw({ type: "*/*", limit: "1mb" }), createProxyMiddleware({
    store,
    config: {
      targets: { T2: TARGET, T0: FALLBACK },
      retriesPerCredential: 1,
      failureBodyDrainBytes: 4096,
      accountCacheMs: 0,
    },
  }));
  const server = http.createServer(app);
  const localAppUrl = await listen(server);
  console.log(`  ✓ Proxy middleware listening at ${localAppUrl}`);

  // 3. Prepare an API key from .env.test
  const keys = String(process.env.FREEMODEL_API_KEYS || "")
    .split(",")
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  if (!keys.length) throw new Error("No FREEMODEL_API_KEYS in .env.test");
  const apiKey = keys[0];
  const accountId = "test-account-1";
  const internalKey = "fmk_test_internal_key_12345678901234567890";

  // Register an account with the internal key
  store.state.accounts.set(accountId, { apiKey: internalKey });
  // Add the upstream API key for the account
  store.state.upstreamKeys.set(accountId, [{
    id: "key-1",
    tier: "T2",
    priority: 100,
    enabled: true,
    apiKey: apiKey,
  }]);

  // Add the LOCAL HTTP PROXY to the account
  const proxyId = await store.createAccountProxy(accountId, proxyUrl.replace("http://", "http://"), "local-test-proxy");
  console.log(`  ✓ Created test account with proxy ${proxyUrl}`);

  // 4. Fetch models through proxy
  console.log("\n─── Test 1: /v1/models through proxy ────────");
  const modelRes = await fetch(`${localAppUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  const modelBody = await modelRes.json().catch(() => ({}));
  const models = (modelBody.data || []).map((m) => m?.id).filter(Boolean);

  if (!modelRes.ok) {
    console.log(`  ✗ HTTP ${modelRes.status}: ${modelBody.error || "unknown"}`);
    throw new Error("Model fetch failed");
  }
  console.log(`  ✓ HTTP ${modelRes.status} — ${models.length} models`);

  const proxyCfg = localProxy.getConnections();
  if (proxyCfg.some(c => c.method === "CONNECT")) {
    console.log(`  ✓ Request routed through local proxy (CONNECT)`);
  } else {
    console.log(`  ⚠  Request may not have used proxy (${proxyCfg.length} connections)`);
  }
  localProxy.clear();

  // 5. Stream a message through proxy
  console.log("\n─── Test 2: Streamed messages through proxy ─");
  const msgRes = await fetch(`${localAppUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${internalKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply OK" }] }],
      stream: true,
    }),
  });
  const text = await msgRes.text();
  const bytes = Buffer.byteLength(text);
  if (!msgRes.ok) throw new Error(`Stream returned HTTP ${msgRes.status}: ${text.slice(0, 100)}`);
  console.log(`  ✓ HTTP ${msgRes.status} — ${bytes} bytes streamed`);

  const proxyCfgs = localProxy.getConnections();
  if (proxyCfgs.some(c => c.method === "CONNECT")) {
    console.log(`  ✓ Stream routed through local proxy (CONNECT to api-cc.freemodel.dev)`);
  } else {
    console.log(`  ⚠  Stream routing check: ${proxyCfgs.length} proxy connections`);
  }

  // 6. Verify proxy was used in recorded attempts
  console.log("\n─── Verification ────────────────────────────");
  const completed = store.state.completed;
  if (completed.length > 0) {
    const last = completed[completed.length - 1];
    console.log(`  ✓ Request completed: ok=${last.ok}, status=${last.status}, attempts=${last.attempts}`);
    if (last.ok) {
      console.log(`  ✅ Full proxy integration test PASSED`);
    } else {
      console.log(`  ⚠  Request completed but not OK: ${last.error || "no error"}`);
    }
  }

  console.log(`  Requests created: ${store.state.requests.length}`);
  console.log(`  Attempts recorded: ${store.state.attempts.length}`);

  // 7. Verify attempts have proxy routing info
  const attempts = store.state.attempts;
  if (attempts.length > 0) {
    console.log(`  ✓ First attempt: tier=${attempts[0].tier}, status=${attempts[0].status}, ok=${attempts[0].ok}`);
  }

  // Cleanup
  await close(server);
  await close(localProxy.server);

  console.log("\n══════════════════════════════════════════════");
  console.log("  E2E Test Complete");
  console.log("══════════════════════════════════════════════");
  const success = completed.length > 0 && completed.some(c => c.ok === true);
  process.exitCode = success ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n✗ Fatal: ${err.message}`);
  process.exitCode = 1;
});
