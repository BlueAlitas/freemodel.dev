import { once } from "node:events";
import http from "node:http";

import "dotenv/config";
import dotenv from "dotenv";
import express from "express";

import { createProxyMiddleware } from "../proxy.js";

dotenv.config({ path: ".env.test", override: true });

const MODEL = "claude-haiku-4-5-20251001";
const TARGET = "https://api-cc.freemodel.dev";
const FALLBACK = "https://cc.freemodel.dev";

function parseKeys() {
  return String(process.env.FREEMODEL_API_KEYS || "")
    .split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

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

function createStore() {
  const state = { requests: [], attempts: [], completed: [] };
  return {
    state,
    async isProxyEnabled() {
      return true;
    },
    async findAccountByApiKey() {
      return null;
    },
    async getAccountUpstreamKeys() {
      return [];
    },
    async createProxyRequest(row) {
      state.requests.push({ ...row });
    },
    async recordProxyAttempt(row) {
      state.attempts.push({ ...row });
    },
    async completeProxyRequest(row) {
      state.completed.push({ ...row });
    },
  };
}

async function fetchModels(apiKey) {
  const res = await fetch(`${TARGET}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/v1/models returned HTTP ${res.status}`);
  const models = (body.data || []).map((item) => item?.id).filter(Boolean);
  if (!models.includes(MODEL)) {
    throw new Error(`${MODEL} was not present in /v1/models`);
  }
  return models.length;
}

async function main() {
  const keys = parseKeys();
  if (!keys.length) {
    throw new Error("FREEMODEL_API_KEYS is empty in .env.test");
  }
  const apiKey = keys[0];
  console.log(`[live] loaded ${keys.length} FREEMODEL_API_KEYS entries`);

  const modelCount = await fetchModels(apiKey);
  console.log(`[live] /v1/models returned ${modelCount} models and includes ${MODEL}`);

  const store = createStore();
  const app = express();
  app.all("/v1/*", express.raw({ type: "*/*", limit: "1mb" }), createProxyMiddleware({
    store,
    config: {
      targets: { T2: TARGET, T0: FALLBACK },
      retriesPerCredential: 1,
      failureBodyDrainBytes: 4096,
    },
  }));
  const server = http.createServer(app);
  const localUrl = await listen(server);

  try {
    const res = await fetch(`${localUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: apiKey,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        messages: [
          { role: "user", content: [{ type: "text", text: "Reply with exactly OK." }] },
        ],
        stream: true,
        temperature: 0,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`local proxy returned HTTP ${res.status}`);
    }
    if (!text.trim()) {
      throw new Error("local proxy returned an empty streamed body");
    }
    console.log(`[live] proxy streamed HTTP ${res.status} with ${Buffer.byteLength(text)} response bytes`);
    console.log(`[live] attempts recorded ${store.state.attempts.length}; final ok ${store.state.completed[0]?.ok === true}`);
  } finally {
    await close(server);
  }
}

main().catch((err) => {
  console.error(`[live] failed: ${err.message}`);
  process.exitCode = 1;
});
