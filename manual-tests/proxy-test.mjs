/* =================================================================
 * proxy-test.mjs — Live integration test with external proxies
 * ----------------------------------------------------------------
 *  Fetches free proxy list, tests SOCKS5 proxies against the
 *  freemodel.dev upstream using Haiku model + .env.test keys.
 * ================================================================= */

import "dotenv/config";
import dotenv from "dotenv";
import { ProxyAgent, Socks5ProxyAgent } from "undici";

dotenv.config({ path: ".env.test", override: true });

const MODEL = "claude-haiku-4-5-20251001";
const TARGET = "https://api-cc.freemodel.dev";
const PROXY_LIST_URL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/all/data.txt";
const TIMEOUT_MS = 15000;
const MAX_PROXIES_TO_TEST = 15;

function parseKeys() {
  return String(process.env.FREEMODEL_API_KEYS || "")
    .split(",")
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function createProxyFetch(proxyUrl) {
  if (!proxyUrl) return (fetchUrl, opts = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
    const existingSignal = opts.signal;
    if (existingSignal) {
      existingSignal.addEventListener("abort", () => controller.abort(existingSignal.reason), { once: true });
    }
    return fetch(fetchUrl, { ...opts, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };
  try {
    const url = String(proxyUrl).trim();
    let agent;
    if (/^socks5h?:\/\//i.test(url)) {
      agent = new Socks5ProxyAgent(url);
    } else if (/^https?:\/\//i.test(url)) {
      agent = new ProxyAgent(url);
    } else {
      return null;
    }
    return (fetchUrl, opts = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
      const existingSignal = opts.signal;
      if (existingSignal) {
        existingSignal.addEventListener("abort", () => controller.abort(existingSignal.reason), { once: true });
      }
      return fetch(fetchUrl, { ...opts, dispatcher: agent, signal: controller.signal })
        .finally(() => clearTimeout(timer));
    };
  } catch (e) {
    console.warn(`  ⚠ Failed to create proxy agent: ${e.message}`);
  }
  return null;
}

async function testProxy(proxyUrl, apiKey) {
  console.log(`\n  Testing: ${proxyUrl}`);
  const proxiedFetch = createProxyFetch(proxyUrl);
  if (!proxiedFetch) {
    console.log(`  ⏭ Skipped - unsupported scheme`);
    return false;
  }

  try {
    // First test: can we reach /v1/models through the proxy?
    const modelRes = await proxiedFetch(`${TARGET}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!modelRes.ok) {
      console.log(`  ✗ /v1/models returned HTTP ${modelRes.status} — proxy likely dead`);
      return false;
    }
    const modelBody = await modelRes.json().catch(() => ({}));
    const models = (modelBody.data || []).map((m) => m?.id).filter(Boolean);
    if (!models.includes(MODEL)) {
      console.log(`  ✗ Haiku not in model list (got ${models.length} models)`);
      return false;
    }
    console.log(`  ✓ /v1/models OK — ${models.length} models discovered`);

    // Second test: stream a Haiku message through the proxy
    const msgRes = await proxiedFetch(`${TARGET}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
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
    if (!msgRes.ok) {
      const errText = await msgRes.text().catch(() => "");
      console.log(`  ✗ Messages returned HTTP ${msgRes.status}: ${errText.slice(0, 120)}`);
      return false;
    }
    const text = await msgRes.text();
    const bytes = Buffer.byteLength(text);
    if (!bytes) {
      console.log(`  ✗ Empty response body`);
      return false;
    }
    console.log(`  ✓ Streamed HTTP ${msgRes.status} — ${bytes} bytes`);
    return true;
  } catch (err) {
    if (err.name === "TimeoutError" || err.code === "UND_ERR_HEADERS_TIMEOUT") {
      console.log(`  ⏱ Timeout — proxy unreachable or too slow`);
    } else if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
      console.log(`  ✗ Connection refused/reset — proxy dead`);
    } else {
      console.log(`  ✗ Error: ${err.message.slice(0, 100)}`);
    }
    return false;
  }
}

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  freemodel.dev — External Proxy Integration Test");
  console.log("══════════════════════════════════════════════\n");

  const keys = parseKeys();
  if (!keys.length) {
    console.error("✗ No API keys found in .env.test");
    process.exitCode = 1;
    return;
  }
  const apiKey = keys[0];
  console.log(`✓ Loaded ${keys.length} API key(s) from .env.test`);
  console.log(`✓ Model: ${MODEL}`);
  console.log(`✓ Target: ${TARGET}\n`);

  // Step 1: Direct test (no proxy) — baseline
  console.log("─── Step 1: Direct connection (no proxy) ─────");
  const directResult = await testProxy(null, apiKey);
  console.log(directResult ? "  ✓ DIRECT OK — upstream reachable" : "  ✗ DIRECT FAILED");

  // Step 2: Fetch proxy list
  console.log("\n─── Step 2: Fetching proxy list ──────────────");
  let proxyList;
  try {
    const res = await fetch(PROXY_LIST_URL, { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    proxyList = text.split("\n").map((l) => l.trim()).filter(Boolean);
    console.log(`✓ Fetched ${proxyList.length} proxies`);
  } catch (err) {
    console.error(`✗ Failed to fetch proxy list: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Filter to SOCKS5 and HTTP proxies
  const socks5Proxies = proxyList.filter((p) => /^socks5h?:\/\//i.test(p));
  const httpProxies = proxyList.filter((p) => /^https?:\/\//i.test(p));
  console.log(`  SOCKS5: ${socks5Proxies.length}  HTTP: ${httpProxies.length}  Other: ${proxyList.length - socks5Proxies.length - httpProxies.length}`);

  // Step 3: Test proxies
  console.log(`\n─── Step 3: Testing ${MAX_PROXIES_TO_TEST} proxies ─────────────`);
  const allProxies = [...socks5Proxies, ...httpProxies];
  const testProxies = allProxies.slice(0, MAX_PROXIES_TO_TEST);
  let workingCount = 0;

  for (let i = 0; i < testProxies.length; i++) {
    const ok = await testProxy(testProxies[i], apiKey);
    if (ok) workingCount++;
  }

  // Summary
  console.log("\n══════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("══════════════════════════════════════════════");
  console.log(`  Direct:                ${directResult ? "✓ WORKING" : "✗ FAILED"}`);
  console.log(`  Proxies tested:        ${testProxies.length}`);
  console.log(`  Proxies working:       ${workingCount}`);
  console.log(`  Success rate:          ${testProxies.length ? ((workingCount / testProxies.length) * 100).toFixed(0) : "N/A"}%`);
  if (workingCount > 0) {
    console.log("\n  ✅ Proxy integration is working!");
  } else {
    console.log("\n  ⚠️  No working proxies found from the free list.");
    console.log("     This is expected — free proxies are unreliable.");
    console.log("     Paid SOCKS5 proxies or HTTP proxies from reliable");
    console.log("     providers will work better in production.");
  }
  console.log("");
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
