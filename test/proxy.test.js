import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

import express from "express";

import {
  buildAccountAttemptPlan,
  buildDirectAttemptPlan,
  createProxyMiddleware,
  decryptSecret,
  encryptSecret,
  extractAuthorizationToken,
  keyHint,
  tokenHash,
} from "../proxy.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function createUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    };
    requests.push(record);
    await handler(req, res, record, requests.length);
  });
  const url = await listen(server);
  return { server, url, requests };
}

function createMemoryStore({ enabled = true, accounts = [], keysByAccount = {} } = {}) {
  const state = {
    requests: [],
    attempts: [],
    completed: [],
  };
  const accountByHash = new Map(accounts.map((account) => [tokenHash(account.apiKey), account]));

  return {
    state,
    async isProxyEnabled() {
      return enabled;
    },
    async findAccountByApiKey(token) {
      return accountByHash.get(tokenHash(token)) || null;
    },
    async getAccountUpstreamKeys(accountId) {
      return keysByAccount[accountId] || [];
    },
    async createProxyRequest(row) {
      state.requests.push({ ...row });
    },
    async recordProxyAttempt(row) {
      state.attempts.push({ ...row });
    },
    async completeProxyRequest(row) {
      state.completed.push({ ...row });
      const request = state.requests.find((item) => item.id === row.requestId);
      if (request) Object.assign(request, row);
    },
  };
}

async function createProxyServer({ store, config }) {
  const app = express();
  app.all("/v1/*", express.raw({ type: "*/*", limit: "1mb" }), createProxyMiddleware({
    store,
    config,
    idFactory: () => "prx_test",
  }));
  const server = http.createServer(app);
  const url = await listen(server);
  return { server, url };
}

test("normalizes bearer variants and redacts key hints", () => {
  assert.equal(extractAuthorizationToken("Bearer abc123"), "abc123");
  assert.equal(extractAuthorizationToken("Barear abc123"), "abc123");
  assert.equal(extractAuthorizationToken("abc123"), "abc123");
  assert.equal(keyHint("Bearer abcdefghijklmnop"), "abcdef…mnop");
});

test("encrypts and decrypts upstream keys", () => {
  const encrypted = encryptSecret("Bearer live-secret", "test-secret");
  assert.notEqual(encrypted, "live-secret");
  assert.equal(decryptSecret(encrypted, "test-secret"), "live-secret");
});

test("builds direct T2 then T0 retry plan", () => {
  const plan = buildDirectAttemptPlan("direct-key", {
    targets: { T2: "https://t2.example", T0: "https://t0.example" },
    retriesPerCredential: 10,
  });
  assert.deepEqual(plan.map((step) => [step.tier, step.maxAttempts, step.token]), [
    ["T2", 10, "direct-key"],
    ["T0", 10, "direct-key"],
  ]);
});

test("builds account retry plan by tier then priority", () => {
  const plan = buildAccountAttemptPlan([
    { id: "k1", tier: "T0", priority: 0, apiKey: "key-t0" },
    { id: "k2", tier: "T2", priority: 20, apiKey: "key-t2-b" },
    { id: "k3", tier: "T2", priority: 10, apiKey: "key-t2-a" },
  ], {
    targets: { T2: "https://t2.example", T0: "https://t0.example" },
    retriesPerCredential: 10,
  });
  assert.deepEqual(plan.map((step) => [step.accountKeyId, step.tier, step.token]), [
    ["k3", "T2", "key-t2-a"],
    ["k2", "T2", "key-t2-b"],
    ["k1", "T0", "key-t0"],
  ]);
});

test("direct proxy hides T2 failures, retries 10 times, then streams T0 success", async () => {
  const t2 = await createUpstream((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "hidden upstream failure" }));
  });
  const t0 = await createUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message\n");
    res.end("data: ok\n\n");
  });
  const store = createMemoryStore();
  const proxy = await createProxyServer({
    store,
    config: {
      targets: { T2: t2.url, T0: t0.url },
      retriesPerCredential: 10,
      failureBodyDrainBytes: 1024,
    },
  });

  try {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "secret prompt should not be stored" }],
      stream: true,
    });
    const res = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "direct-user-key",
        "content-type": "application/json",
      },
      body,
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.equal(text, "event: message\ndata: ok\n\n");
    assert.equal(t2.requests.length, 10);
    assert.equal(t0.requests.length, 1);
    assert.equal(t0.requests[0].headers.authorization, "Bearer direct-user-key");
    assert.equal(store.state.attempts.length, 11);
    assert.equal(store.state.attempts.slice(0, 10).every((attempt) => attempt.tier === "T2" && !attempt.ok), true);
    assert.equal(store.state.attempts[10].tier, "T0");
    assert.equal(store.state.completed[0].ok, true);
    assert.equal(store.state.requests[0].requestModel, "claude-haiku-4-5-20251001");
    assert.equal(JSON.stringify(store.state).includes("secret prompt should not be stored"), false);
  } finally {
    await close(proxy.server);
    await close(t2.server);
    await close(t0.server);
  }
});

test("direct proxy supports bodyless GET model discovery", async () => {
  const t2 = await createUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-haiku-4-5-20251001" }] }));
  });
  const t0 = await createUpstream((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const store = createMemoryStore();
  const proxy = await createProxyServer({
    store,
    config: {
      targets: { T2: t2.url, T0: t0.url },
      retriesPerCredential: 10,
      failureBodyDrainBytes: 1024,
    },
  });

  try {
    const res = await fetch(`${proxy.url}/v1/models`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { data: [{ id: "claude-haiku-4-5-20251001" }] });
    assert.equal(t2.requests.length, 1);
    assert.equal(t2.requests[0].method, "GET");
    assert.equal(t2.requests[0].body, "");
    assert.equal(t0.requests.length, 0);
    assert.equal(store.state.completed[0].ok, true);
  } finally {
    await close(proxy.server);
    await close(t2.server);
    await close(t0.server);
  }
});

test("proxy strips stale content-encoding after upstream decompression", async () => {
  const t2 = await createUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-encoding": "gzip",
    });
    res.end(gzipSync("ok"));
  });
  const t0 = await createUpstream((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const store = createMemoryStore();
  const proxy = await createProxyServer({
    store,
    config: {
      targets: { T2: t2.url, T0: t0.url },
      retriesPerCredential: 10,
      failureBodyDrainBytes: 1024,
    },
  });

  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "direct-user-key",
        "accept-encoding": "gzip, br, zstd",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
    });
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.equal(body, "ok");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal(t2.requests[0].headers["accept-encoding"], "identity");
  } finally {
    await close(proxy.server);
    await close(t2.server);
    await close(t0.server);
  }
});

test("internal account proxy rotates upstream keys by priority", async () => {
  const seenAuth = [];
  const t2 = await createUpstream((_req, res, record) => {
    seenAuth.push(record.headers.authorization);
    if (record.headers.authorization === "Bearer upstream-a") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const t0 = await createUpstream((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const account = { id: "acct_test", apiKey: "internal-key" };
  const store = createMemoryStore({
    accounts: [account],
    keysByAccount: {
      acct_test: [
        { id: "key_a", tier: "T2", priority: 1, apiKey: "upstream-a" },
        { id: "key_b", tier: "T2", priority: 2, apiKey: "upstream-b" },
      ],
    },
  });
  const proxy = await createProxyServer({
    store,
    config: {
      targets: { T2: t2.url, T0: t0.url },
      retriesPerCredential: 2,
      failureBodyDrainBytes: 1024,
    },
  });

  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Barear internal-key",
        "x-api-key": "internal-key",
        "anthropic-api-key": "internal-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: true }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.equal(text, JSON.stringify({ ok: true }));
    assert.deepEqual(seenAuth, [
      "Bearer upstream-a",
      "Bearer upstream-a",
      "Bearer upstream-b",
    ]);
    assert.equal(t2.requests[0].headers["x-api-key"], "upstream-a");
    assert.equal(t2.requests[0].headers["anthropic-api-key"], "upstream-a");
    assert.equal(t2.requests[2].headers["x-api-key"], "upstream-b");
    assert.equal(t2.requests[2].headers["anthropic-api-key"], "upstream-b");
    assert.equal(t0.requests.length, 0);
    assert.equal(store.state.requests[0].accountId, "acct_test");
    assert.equal(store.state.attempts.length, 3);
    assert.equal(store.state.completed[0].ok, true);
  } finally {
    await close(proxy.server);
    await close(t2.server);
    await close(t0.server);
  }
});

test("disabled proxy records and rejects requests before upstream attempts", async () => {
  const t2 = await createUpstream((_req, res) => {
    res.writeHead(200);
    res.end("should not be called");
  });
  const store = createMemoryStore({ enabled: false });
  const proxy = await createProxyServer({
    store,
    config: {
      targets: { T2: t2.url, T0: t2.url },
      retriesPerCredential: 10,
      failureBodyDrainBytes: 1024,
    },
  });

  try {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
    });
    const body = await res.json();

    assert.equal(res.status, 503);
    assert.equal(body.error, "proxy_disabled");
    assert.equal(t2.requests.length, 0);
    assert.equal(store.state.attempts.length, 0);
    assert.equal(store.state.completed[0].ok, false);
    assert.equal(store.state.completed[0].status, 503);
  } finally {
    await close(proxy.server);
    await close(t2.server);
  }
});
