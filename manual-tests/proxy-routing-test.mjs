/* =================================================================
 * proxy-routing-test.mjs — Test proxy routing code directly
 * ----------------------------------------------------------------
 *  Validates that createProxiedFetch, pickProxyUrl, and the
 *  proxy routing through the proxy system all work correctly.
 * ================================================================= */

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { ProxyAgent, Socks5ProxyAgent } from "undici";

// Replicate the exact logic from proxy.js for testing
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

function pickProxyUrl(proxies) {
  if (!proxies || !proxies.length) return null;
  return proxies[Math.floor(Math.random() * proxies.length)].proxyUrl;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  Proxy Routing — Unit Test");
  console.log("══════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label}`);
      failed++;
    }
  }

  /* ----- Test 1: pickProxyUrl ----- */
  console.log("─── pickProxyUrl ────────────────────────────");
  assert(pickProxyUrl(null) === null, "null list returns null");
  assert(pickProxyUrl([]) === null, "empty list returns null");
  const proxies = [{ proxyUrl: "http://1.2.3.4:8080" }, { proxyUrl: "http://5.6.7.8:8080" }];
  const picked = pickProxyUrl(proxies);
  assert(picked === "http://1.2.3.4:8080" || picked === "http://5.6.7.8:8080", "picks from list");
  assert(pickProxyUrl([{ proxyUrl: "http://fixed:8080" }]) === "http://fixed:8080", "single item works");

  /* ----- Test 2: createProxiedFetch ----- */
  console.log("\n─── createProxiedFetch ──────────────────────");
  const noProxy = createProxiedFetch(null);
  assert(typeof noProxy === "function", "null proxyUrl returns fetch function");
  assert(noProxy === globalThis.fetch, "null proxyUrl returns globalThis.fetch");

  const emptyProxy = createProxiedFetch("");
  assert(typeof emptyProxy === "function", "empty string returns fetch function");
  assert(emptyProxy === globalThis.fetch, "empty string returns globalThis.fetch");

  const httpProxy = createProxiedFetch("http://127.0.0.1:3128");
  assert(typeof httpProxy === "function", "http proxy returns fetch function");
  assert(httpProxy !== globalThis.fetch, "http proxy returns proxied fetch");

  const socksProxy = createProxiedFetch("socks5://127.0.0.1:1080");
  assert(typeof socksProxy === "function", "socks5 proxy returns fetch function");
  assert(socksProxy !== globalThis.fetch, "socks5 proxy returns proxied fetch");

  const socks5hProxy = createProxiedFetch("socks5h://127.0.0.1:1080");
  assert(typeof socks5hProxy === "function", "socks5h proxy returns fetch function");

  /* ----- Test 3: HTTP proxy routing via local proxy ----- */
  console.log("\n─── HTTP Proxy Routing (local echo proxy) ───");

  // Create a local HTTP proxy server (simple CONNECT + forward)
  const proxyConnections = [];
  const proxyServer = http.createServer((req, res) => {
    if (req.method === "CONNECT") {
      const [host, port] = req.url.split(":");
      proxyConnections.push({ type: "CONNECT", host, port: parseInt(port, 10) });
      // Tunnel through
      const c = net.connect(parseInt(port, 10) || 443, host, () => {
        res.writeHead(200, {});
        res.socket.pipe(c);
        c.pipe(res.socket);
      });
      c.on("error", () => { res.writeHead(502); res.end(); });
      return;
    }
    // Forward regular HTTP
    proxyConnections.push({ type: "HTTP", url: req.url });
    const options = new URL(req.url);
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
    proxyReq.on("error", () => { res.writeHead(502); res.end(); });
  });
  const proxyServerUrl = await listen(proxyServer);
  console.log(`  Local proxy: ${proxyServerUrl}`);

  // Create a target HTTP server that we'll reach through the proxy
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url, via: "proxy-test" }));
  });
  const targetUrl = await listen(targetServer);
  console.log(`  Target server: ${targetUrl}`);

  // Now test: fetch target through proxy
  const proxiedFetch = createProxiedFetch(proxyServerUrl); // http:// proxy
  try {
    const res = await proxiedFetch(`${targetUrl}/test-path`, {
      headers: { accept: "application/json" },
    });
    const body = await res.json();
    assert(res.ok && body.ok === true, "successful proxied request");
    assert(body.path === "/test-path", "correct path through proxy");
    assert(proxyConnections.length > 0, "proxy was used (connection recorded)");
    if (proxyConnections.length > 0) {
      console.log(`  📡 Proxy connections: ${proxyConnections.map(c => c.type).join(", ")}`);
    }
  } catch (err) {
    assert(false, `proxied fetch: ${err.message}`);
  }

  /* ----- Test 4: Proxy rotation ----- */
  console.log("\n─── Proxy Rotation ──────────────────────────");
  const proxyList = [
    { proxyUrl: "http://rot1.test:8080" },
    { proxyUrl: "http://rot2.test:8080" },
    { proxyUrl: "http://rot3.test:8080" },
  ];
  const picks = new Set();
  for (let i = 0; i < 20; i++) {
    picks.add(pickProxyUrl(proxyList));
  }
  assert(picks.size === 3, "pickProxyUrl rotates through all proxies");
  console.log(`  ${picks.size} unique URLs picked from ${proxyList.length} options (20 iterations)`);

  /* ----- Cleanup ----- */
  targetServer.close();
  proxyServer.close();

  /* ----- Summary ----- */
  console.log("\n══════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════\n");
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
