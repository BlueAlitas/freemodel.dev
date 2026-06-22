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

// Pool tuned for a low-traffic status page: small cap, short idle timeout.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 8,
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
