/* =================================================================
 * proxy-checker.mjs — Find working proxies from free list
 * ----------------------------------------------------------------
 *  Quick connectivity check: fetch a known URL through each proxy
 *  to find working ones before testing the full freemodel flow.
 * ================================================================= */

import { ProxyAgent, Socks5ProxyAgent } from "undici";

const PROXY_LIST_URL = "https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/all/data.txt";
const TIMEOUT_MS = 8000;
const MAX_CHECK = 30;

function createCheckFetch(proxyUrl) {
  try {
    let agent;
    if (/^socks5h?:\/\//i.test(proxyUrl)) {
      agent = new Socks5ProxyAgent(proxyUrl);
    } else if (/^https?:\/\//i.test(proxyUrl)) {
      agent = new ProxyAgent(proxyUrl);
    } else {
      return null;
    }
    return (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
      return fetch(url, { dispatcher: agent, signal: controller.signal, method: "HEAD" })
        .finally(() => clearTimeout(timer));
    };
  } catch { return null; }
}

async function checkProxy(proxyUrl) {
  const doFetch = createCheckFetch(proxyUrl);
  if (!doFetch) return false;
  try {
    const res = await doFetch("https://httpbin.org/get");
    return res.ok;
  } catch { return false; }
}

async function main() {
  console.log("Fetching proxy list...");
  const res = await fetch(PROXY_LIST_URL);
  const text = await res.text();
  const all = text.split("\n").map(s => s.trim()).filter(Boolean);
  console.log(`Total: ${all.length} proxies`);

  const socks5 = all.filter(p => /^socks5h?:\/\//i.test(p)).slice(0, Math.ceil(MAX_CHECK/2));
  const http = all.filter(p => /^https?:\/\//i.test(p)).slice(0, Math.ceil(MAX_CHECK/2));
  const toCheck = [...socks5, ...http];

  console.log(`Checking ${toCheck.length} proxies (${socks5.length} SOCKS5 + ${http.length} HTTP)...\n`);

  const working = [];
  for (let i = 0; i < toCheck.length; i++) {
    const ok = await checkProxy(toCheck[i]);
    console.log(`${ok ? "✓" : "✗"} [${i + 1}/${toCheck.length}] ${toCheck[i]}`);
    if (ok) working.push(toCheck[i]);
    if (working.length >= 3) break;
  }

  console.log(`\nWorking proxies found: ${working.length}`);
  working.forEach(p => console.log(`  ✓ ${p}`));

  if (working.length > 0) {
    console.log(`\nSave these to test with the proxy system:`);
    console.log(JSON.stringify(working, null, 2));
  } else {
    console.log("\nNo working proxies found. Free proxy lists are unreliable.");
    console.log("For production, use paid proxy providers instead.");
  }
}

main().catch(console.error);
