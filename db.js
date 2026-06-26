/* =================================================================
 * db.js — Postgres pool + schema bootstrap
 * ----------------------------------------------------------------
 *  Single connection pool for the whole process. `init()` runs an
 *  idempotent CREATE TABLE IF NOT EXISTS for every table, so a
 *  fresh database comes up usable.
 * ================================================================= */

import pg from "pg";
import { setTimeout as wait } from "node:timers/promises";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[db] DATABASE_URL is not set. Refusing to start.");
  process.exit(1);
}

function positiveIntEnv(keys, fallback) {
  for (const key of keys) {
    const value = parseInt(process.env[key] ?? "", 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

const POOL_MAX = positiveIntEnv(["POSTGRES_POOL_MAX", "DATABASE_POOL_MAX", "PGPOOL_MAX"], 20);

// Shared pool sized for proxy traffic. Tune POSTGRES_POOL_MAX to match the
// database connection budget and the number of app replicas.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "freemodel-status",
});

pool.on("error", (err) => {
  console.error("[db] idle client error:", err);
});

/** Run a single query with parameterised SQL. */
export async function query(sql, params) {
  return pool.query(sql, params);
}

/** Run a callback inside a transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/* ---------- schema ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  target        TEXT        NOT NULL,
  id            TEXT        NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  PRIMARY KEY (target, id)
);

CREATE TABLE IF NOT EXISTS probes (
  id         BIGSERIAL   PRIMARY KEY,
  target     TEXT        NOT NULL,
  model      TEXT        NOT NULL,
  ok         BOOLEAN     NOT NULL,
  status     INT         NOT NULL,
  latency_ms REAL        NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  error      TEXT
);
CREATE INDEX IF NOT EXISTS probes_target_model_ts_idx
  ON probes (target, model, ts DESC);
CREATE INDEX IF NOT EXISTS probes_ts_idx
  ON probes (ts DESC);

CREATE TABLE IF NOT EXISTS visits (
  id         BIGSERIAL   PRIMARY KEY,
  visitor_id TEXT        NOT NULL,
  path       TEXT        NOT NULL,
  referrer   TEXT,
  user_agent TEXT,
  country    TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_visitor_idx ON visits (visitor_id);
CREATE INDEX IF NOT EXISTS visits_ts_idx      ON visits (ts DESC);
-- Daily aggregations: rely on visits_ts_idx (a 30-day scan is small) rather
-- than a per-day functional index, because timestamptz->date casts in index
-- expressions are timezone-dependent (STABLE, not IMMUTABLE) and Postgres
-- rejects them. Same end result; cheaper to maintain.

CREATE TABLE IF NOT EXISTS sessions (
  visitor_id TEXT        PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen DESC);

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT        PRIMARY KEY,
  api_key_hash TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_created_at_idx ON accounts (created_at DESC);

CREATE TABLE IF NOT EXISTS account_upstream_keys (
  id             TEXT        PRIMARY KEY,
  account_id     TEXT        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label          TEXT,
  tier           TEXT        NOT NULL CHECK (tier IN ('T0', 'T2')),
  priority       INT         NOT NULL DEFAULT 100,
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  key_hash       TEXT        NOT NULL,
  key_hint       TEXT        NOT NULL,
  key_ciphertext TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_upstream_keys_account_idx
  ON account_upstream_keys (account_id, enabled, tier, priority, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS account_upstream_keys_unique_hash_idx
  ON account_upstream_keys (account_id, key_hash);

CREATE TABLE IF NOT EXISTS proxy_processes (
  id         TEXT        PRIMARY KEY,
  hostname   TEXT,
  pid        INT,
  worker_id  TEXT,
  role       TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proxy_processes_last_seen_idx
  ON proxy_processes (last_seen DESC);

CREATE TABLE IF NOT EXISTS proxy_requests (
  id            TEXT        PRIMARY KEY,
  account_id    TEXT        REFERENCES accounts(id) ON DELETE SET NULL,
  proxy_process_id TEXT,
  method        TEXT        NOT NULL,
  route_path    TEXT        NOT NULL,
  request_model TEXT,
  ok            BOOLEAN,
  final_status  INT,
  latency_ms    REAL,
  attempts      INT         NOT NULL DEFAULT 0,
  upstream_tier TEXT,
  upstream_url  TEXT,
  error         TEXT,
  streamed      BOOLEAN     NOT NULL DEFAULT false,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
ALTER TABLE proxy_requests
  ADD COLUMN IF NOT EXISTS proxy_process_id TEXT;
CREATE INDEX IF NOT EXISTS proxy_requests_started_at_idx
  ON proxy_requests (started_at DESC);
CREATE INDEX IF NOT EXISTS proxy_requests_account_idx
  ON proxy_requests (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS proxy_requests_completed_at_idx
  ON proxy_requests (completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS proxy_requests_account_completed_idx
  ON proxy_requests (account_id, completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS proxy_requests_active_started_idx
  ON proxy_requests (started_at DESC) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS proxy_requests_process_active_idx
  ON proxy_requests (proxy_process_id, started_at DESC) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS proxy_attempts (
  id             BIGSERIAL   PRIMARY KEY,
  request_id     TEXT        NOT NULL REFERENCES proxy_requests(id) ON DELETE CASCADE,
  attempt_no     INT         NOT NULL,
  account_key_id TEXT,
  tier           TEXT        NOT NULL,
  upstream_url   TEXT        NOT NULL,
  status         INT         NOT NULL DEFAULT 0,
  ok             BOOLEAN     NOT NULL DEFAULT false,
  latency_ms     REAL        NOT NULL,
  error          TEXT,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proxy_attempts_request_idx
  ON proxy_attempts (request_id, attempt_no);
CREATE INDEX IF NOT EXISTS proxy_attempts_ts_idx
  ON proxy_attempts (ts DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value)
VALUES ('proxy_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
`;

/** Wait for DB to be ready, then create tables. Retries with backoff. */
export async function init({ retries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      await pool.query(SCHEMA);
      console.log("[db] ready");
      return;
    } catch (e) {
      if (i === retries - 1) {
        console.error(`[db] init failed after ${retries} attempts:`, e.message);
        throw e;
      }
      console.warn(`[db] not ready (${e.message}); retrying in ${delayMs}ms`);
      await wait(delayMs);
    }
  }
}

export async function close() {
  await pool.end();
}
