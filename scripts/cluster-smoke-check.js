import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

import "dotenv/config";

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error("health check timed out");
}

async function terminate(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  timer.unref();
  await once(child, "exit").catch(() => {});
  clearTimeout(timer);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for cluster smoke check");
  }

  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      WEB_CONCURRENCY: "2",
      POLLER_ENABLED: "false",
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || "cluster-smoke-admin-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
    const responses = await Promise.all(Array.from({ length: 80 }, () => (
      fetch(`${baseUrl}/api/health`, { cache: "no-store" }).then((res) => res.json())
    )));
    const workers = new Set(responses.map((body) => body.worker?.id).filter(Boolean));
    const pids = new Set(responses.map((body) => body.worker?.pid).filter(Boolean));

    if (workers.size < 2 || pids.size < 2) {
      throw new Error(`expected at least 2 workers, saw workers=${[...workers].join(",") || "none"} pids=${[...pids].join(",") || "none"}`);
    }

    const configRes = await fetch(`${baseUrl}/api/config`, { cache: "no-store" });
    const config = await configRes.json();
    if (!configRes.ok || config.webConcurrency !== 2 || config.pollerEnabled !== false) {
      throw new Error(`unexpected config response: ${JSON.stringify(config)}`);
    }

    const statusRes = await fetch(`${baseUrl}/api/status`, { cache: "no-store" });
    const status = await statusRes.json();
    if (!statusRes.ok || !Array.isArray(status.targets)) {
      throw new Error(`unexpected status response: ${JSON.stringify(status)}`);
    }

    console.log(JSON.stringify({
      clusterSmoke: true,
      webConcurrency: 2,
      workers: [...workers].sort(),
      pids: [...pids].sort((a, b) => a - b),
      statusTargets: status.targets.length,
    }));
  } catch (err) {
    const tail = output.split(/\r?\n/).slice(-40).join("\n");
    throw new Error(`${err.message}\n--- server output ---\n${tail}`);
  } finally {
    await terminate(child);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ clusterSmoke: false, error: err.message }));
  process.exitCode = 1;
});
