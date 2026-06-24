import { once } from "node:events";
import http from "node:http";

import "dotenv/config";
import express from "express";

import { close as closeDb, init, query } from "../db.js";
import { registerAccountAndAdminRoutes } from "../proxy.js";

const ADMIN_TOKEN = "db-smoke-admin-token";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function request(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.admin ? { "x-admin-token": ADMIN_TOKEN } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function main() {
  await init({ retries: 1, delayMs: 10 });

  const app = express();
  app.use(express.json({ limit: "32kb" }));
  registerAccountAndAdminRoutes(app, {
    query,
    config: {
      adminToken: ADMIN_TOKEN,
      keySecret: "db-smoke-key-secret",
    },
  });
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  let accountId = null;
  try {
    const created = await request(baseUrl, "/api/accounts", {
      method: "POST",
      body: "{}",
    });
    accountId = created.account.id;
    if (!created.apiKey || !accountId) throw new Error("account creation response incomplete");

    const keyAdded = await request(baseUrl, `/api/accounts/${encodeURIComponent(accountId)}/keys`, {
      method: "POST",
      body: JSON.stringify({
        label: "smoke",
        apiKey: `fake-freemodel-key-${Date.now()}`,
        tier: "T2",
        priority: 1,
      }),
    });
    const key = keyAdded.account.keys[0];
    if (!key || key.tier !== "T2" || key.priority !== 1) throw new Error("upstream key was not added");
    if (JSON.stringify(keyAdded).includes("fake-freemodel-key")) throw new Error("raw upstream key leaked in response");

    const updated = await request(baseUrl, `/api/accounts/${encodeURIComponent(accountId)}/keys/${encodeURIComponent(key.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ tier: "T0", priority: 2, enabled: false }),
    });
    if (updated.account.keys[0].tier !== "T0" || updated.account.keys[0].enabled !== false) {
      throw new Error("upstream key update failed");
    }

    const rotated = await request(baseUrl, `/api/accounts/${encodeURIComponent(accountId)}/api-key`, {
      method: "POST",
      body: "{}",
    });
    if (!rotated.apiKey || rotated.apiKey === created.apiKey) throw new Error("API key rotation failed");

    const overview = await request(baseUrl, "/api/admin/overview", { admin: true });
    if (!overview.accounts.some((account) => account.id === accountId)) {
      throw new Error("admin overview did not include smoke account");
    }

    await request(baseUrl, `/api/admin/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      admin: true,
    });
    accountId = null;

    let deleted = false;
    try {
      await request(baseUrl, `/api/accounts/${encodeURIComponent(created.account.id)}`);
    } catch (err) {
      deleted = err.status === 404;
    }
    if (!deleted) throw new Error("account deletion was not observed");

    console.log(JSON.stringify({ dbSmoke: true, accountRoutes: true, adminRoutes: true }));
  } finally {
    if (accountId) {
      await query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => {});
    }
    await closeServer(server);
    await closeDb();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ dbSmoke: false, error: err.message }));
  process.exitCode = 1;
});
