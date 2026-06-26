# freemodel.dev status

Live status, latency, reverse proxying, account API-key rotation, admin controls, and lightweight unique visitor stats for the freemodel.dev LLM gateway.

* **Polling**: probes run once on server start, then every minute until 50 consecutive probe requests are 2xx. Any failure resets that counter. After confirmation, probes run every 30 min.
* **Targets**: `https://cc.freemodel.dev` and `https://api-cc.freemodel.dev` (Anthropic-compatible).
* **Models**: discovered dynamically from `GET /v1/models` on each target; configurable test set via `TEST_MODELS`.
* **Proxy**: Anthropic-compatible `/v1/*` and `/proxy/v1/*` routes prefer T2 (`https://api-cc.freemodel.dev`), retry hidden upstream failures, and fall back to T0 (`https://cc.freemodel.dev`).
* **Accounts**: users can create a generated account ID, receive an internal API key, store multiple freemodel.dev keys by tier and priority, and delete the account.
* **Admin**: `/admin` uses `ADMIN_TOKEN` for account deletion, proxy enable/disable, active request visibility, request history, and charts.
* **Storage**: PostgreSQL (auto-creates tables on boot).
* **Worker pool**: `WEB_CONCURRENCY` can run multiple Node web workers behind one primary process, so concurrent proxy traffic is spread across processes.
* **Visitor stats**: tracked as unique visitors using a one-way hash of IP + User-Agent. Reloading the page updates activity but does not create another visit.

## Run locally

```bash
cp .env.example .env
# fill in DATABASE_URL + FREEMODEL_TOKEN
npm install
npm start
# → http://localhost:3000
```

Run the Claude-Code-style Haiku probe without starting the server or using Postgres:

```bash
node probe.js
# or
node poller.js
```

You'll need a Postgres running locally. Quickest path:

```bash
docker run -d --name fm-pg -p 5432:5432 \
  -e POSTGRES_USER=fm -e POSTGRES_PASSWORD=fm -e POSTGRES_DB=freemodel_status \
  postgres:16-alpine

# then in .env:
DATABASE_URL=postgres://fm:fm@localhost:5432/freemodel_status
```

## Deploy to Dokploy

1. Push this repo to your git provider.
2. In Dokploy, **Create Service → Application → Docker Compose**, point it at the repo.
3. Set the environment variables in Dokploy's UI (notably `DATABASE_URL` and `FREEMODEL_TOKEN`).
4. In **Domains**, add `fm.bluealitas.com` — Dokploy will write the Traefik labels and provision a Let's Encrypt certificate. (The compose file already includes the labels as a fallback.)
5. Connect Dokploy to your managed Postgres and paste its connection string into `DATABASE_URL`.
6. Set `WEB_CONCURRENCY` to the number of Node web workers per container. The compose default is `2`.
7. Set `POSTGRES_POOL_MAX` based on the Postgres connection limit divided by the total Node process count. With the default primary poller plus two workers, the default `20` means roughly 60 database connections per container.

## Production readiness

The reverse proxy path is async and streams successful upstream responses back to clients. It does not store request or response bodies, and it disables Node socket timeouts for long Claude streams. Failed upstream responses are drained only up to `PROXY_FAILURE_DRAIN_BYTES`, then retried or hidden behind the final 502 response.

For production, `WEB_CONCURRENCY` starts a primary process plus multiple web workers sharing the same HTTP port. The primary runs the status poller once, while workers handle `/v1/*`, `/account`, `/admin`, and API traffic. Status workers read poller history from Postgres, so scaling workers does not duplicate upstream probe calls.

The main shared bottleneck is Postgres metadata writes and account/key lookups. Production defaults use a `20` connection pool per Node process, short 5-second account/key lookup caching with single-flight coalescing, and indexes for admin history, active requests, and account usage charts. For thousands of users, use `WEB_CONCURRENCY` inside each container and, if needed, multiple Dokploy replicas. Keep `POSTGRES_POOL_MAX * (WEB_CONCURRENCY + 1) * replicas` below the database connection limit, and keep Traefik/proxy read idle timeouts long enough for streamed LLM responses.

The public home page is intentionally based only on the internal poller's `probes` table. User proxy failures are visible on `/account` for that account and `/admin` for operators, but they do not change the home-screen service status.

## Routes

| Path | Description |
|---|---|
| `GET /` | Status page |
| `GET /account` | Account/key management page |
| `GET /admin` | Admin page; requires `ADMIN_TOKEN` for API calls |
| `ANY /v1/*` | Anthropic-compatible reverse proxy |
| `ANY /proxy/v1/*` | Same proxy with `/proxy` stripped before upstream forwarding |
| `GET /api/status` | JSON snapshot (target × model history, percentiles, uptime) |
| `GET /api/stats` | Unique visitor stats: today, active now, 30-day daily series, top countries |
| `GET /api/visits/recent?limit=50` | Recent visit log; requires `ADMIN_TOKEN` |
| `GET /api/health` | Liveness probe (checks DB connectivity) |
| `GET /api/config` | Public-safe runtime config |
| `POST /api/accounts` | Create generated account and one-time internal API key |
| `GET /api/accounts/:id` | Load account metadata and stored upstream-key list |
| `GET /api/accounts/:id/usage` | Account-scoped 24h proxy usage success rate, hourly buckets, breakdowns, and official probe baseline |
| `DELETE /api/accounts/:id` | Delete account and stored upstream keys |
| `POST /api/accounts/:id/api-key` | Rotate internal API key |
| `POST /api/accounts/:id/keys` | Add upstream freemodel.dev key with `tier`, `priority`, `label` |
| `PATCH /api/accounts/:id/keys/:keyId` | Update upstream-key label, tier, priority, enabled state |
| `DELETE /api/accounts/:id/keys/:keyId` | Delete stored upstream key |
| `GET /api/admin/overview` | Admin overview: system state, active requests, history, charts, accounts |
| `PATCH /api/admin/system` | Admin proxy enable/disable |
| `GET /api/admin/requests/:id` | Admin request attempts |
| `DELETE /api/admin/accounts/:id` | Admin account deletion |

## Proxy behavior

For direct freemodel.dev keys, callers send `Authorization: Bearer <key>` or `Authorization: <key>` to `/v1/*`. The proxy forwards the request to T2 up to `PROXY_RETRIES_PER_CREDENTIAL` times, then T0 up to the same count. Non-2xx upstream responses are consumed and retried without being sent downstream. If all attempts fail, downstream receives a 502 JSON response with the proxy request ID.

For internal account keys, callers send the generated internal key in `Authorization`. The proxy looks up the account, loads enabled upstream keys, sorts T2 keys before T0 keys and then by ascending priority, and retries each stored key up to `PROXY_RETRIES_PER_CREDENTIAL` times. Successful upstream responses are streamed to downstream clients with no proxy timeout. Request and attempt metadata are stored, but request and response bodies are not.

Admin API access uses `ADMIN_TOKEN` through `x-admin-token`, `Authorization`, or the token field on `/admin`.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `DATABASE_URL` | _(required)_ | `postgres://user:pass@host:5432/db` |
| `POSTGRES_POOL_MAX` | `20` | Max Postgres connections per Node process. Aliases: `DATABASE_POOL_MAX`, `PGPOOL_MAX`. |
| `WEB_CONCURRENCY` | `1` locally / `2` in compose | Number of web worker processes sharing the HTTP port. Supports `auto`. |
| `POLLER_ENABLED` | `true` | Run the internal status poller. In clustered mode, only the primary runs it. |
| `TARGET_URLS` | `https://cc.freemodel.dev,https://api-cc.freemodel.dev` | Comma-separated. |
| `FREEMODEL_TOKEN` | _(empty)_ | Bearer token sent as `Authorization: Bearer …`. |
| `PROXY_T2_URL` | `https://api-cc.freemodel.dev` | Preferred proxy upstream. |
| `PROXY_T0_URL` | `https://cc.freemodel.dev` | Proxy fallback upstream. |
| `PROXY_RETRIES_PER_CREDENTIAL` | `10` | Attempts per direct key, stored account key, or tier. |
| `PROXY_BODY_LIMIT` | `20mb` | Max buffered request body for retryable proxy requests. |
| `PROXY_FAILURE_DRAIN_BYTES` | `65536` | Max failed-response bytes drained before retrying another upstream attempt. |
| `PROXY_SUCCESS_BUFFER_BYTES` | `0` | When greater than `0`, fully buffers successful upstream responses up to this byte limit before sending them downstream, allowing terminated 2xx streams to be retried. |
| `PROXY_ACCOUNT_CACHE_MS` | `5000` | Short cache for internal API-key and stored upstream-key lookups. Set `0` to disable. |
| `PROXY_ACCOUNT_CACHE_MAX` | `10000` | Max cached account/key entries per app process. |
| `PROXY_PROCESS_HEARTBEAT_MS` | `30000` | How often each app process refreshes its DB heartbeat for active-request ownership. |
| `PROXY_PROCESS_STALE_MS` | `300000` | Active requests owned by a process with no fresh heartbeat after this window are marked complete. |
| `PROXY_STALE_CLEANUP_INTERVAL_MS` | `60000` | How often each app process scans for abandoned active proxy requests. |
| `PROXY_LEGACY_ACTIVE_REQUEST_STALE_MS` | `21600000` | Ownerless active rows from older deployments are marked complete only after this conservative age. |
| `ADMIN_TOKEN` | _(empty)_ | Required token for `/api/admin/*`. |
| `PROXY_KEY_SECRET` | `ADMIN_TOKEN` / local fallback | AES-GCM secret for stored upstream API keys. |
| `TEST_MODELS` | `claude-haiku-4-5-20251001` | `*` = test every discovered model. |
| `PROBE_TARGET_URL` | `https://api-cc.freemodel.dev` | Default target for `node probe.js` / `node poller.js`. |
| `PROBE_SESSION_TEXT` | `Calculate 1+1` | Session text embedded in the Claude Code title-generation probe prompt. |
| `CLAUDE_CODE_BILLING_HEADER` | `cc_version=2.1.185.042; cc_entrypoint=cli;` | Billing-header text embedded in the probe system prompt. |
| `INTERVAL_HEALTHY_MS` | `1800000` | 30 min — used when last probe was 2xx. |
| `INTERVAL_RETRY_MS` | `60000` | 1 min — used until a 2xx is observed. |
| `HEALTHY_CONFIRMATION_REQUESTS` | `50` | Keep retry cadence until this many consecutive probe requests are 2xx; any failure resets the counter. |
| `MODEL_REFRESH_MS` | `21600000` | How often to re-fetch `/v1/models`. |
| `TRACK_PATHS` | `/` | Comma-separated path prefixes that get visitor tracking. `/api/*` is always excluded. |
| `ACTIVE_WINDOW_MIN` | `5` | "Active now" window. |
| `PORT` | `3000` | HTTP listen port. |

## Schema

Auto-created on boot:

| Table | Purpose |
|---|---|
| `models` | Per-target registry of discovered models. Tracks `enabled`, `removed_at`. |
| `probes` | Every probe result. Indexed on `(target, model, ts DESC)`. |
| `visits` | One row per unique visitor fingerprint (visitor_id, first path/referrer/ua/country, ts). |
| `sessions` | One row per unique visitor; `last_seen` heartbeat drives "active now". |
| `accounts` | Generated account IDs and hashed internal API keys. |
| `account_upstream_keys` | Stored freemodel.dev API keys with tier, priority, enabled state, hash, hint, and encrypted/reversible secret. |
| `proxy_processes` | Live app-process heartbeats used to retire abandoned active proxy requests after restarts. |
| `proxy_requests` | Proxy request metadata, process owner, final status, latency, attempt count, selected upstream, and error text. |
| `proxy_attempts` | Per-attempt tier, upstream, status, latency, and error metadata. |
| `system_settings` | Runtime flags such as `proxy_enabled`. |

## Testing

```bash
npm test
```

The deterministic test suite uses local mock upstreams and covers retry fallback, bodyless model discovery, internal-key rotation, stale compressed-header handling, concurrent proxied requests, disabled-proxy behavior, poller error sanitization, and the no-body-storage invariant.

To smoke-test account/admin routes against the configured Postgres without touching upstream LLM APIs:

```bash
npm run test:db
```

To smoke-test the production worker-pool boot path locally, without upstream probe calls:

```bash
npm run test:cluster
```

That command starts `server.js` with `WEB_CONCURRENCY=2` and `POLLER_ENABLED=false`, sends parallel health requests, and verifies they are served by at least two worker processes.

To run a live low-cost check through the local proxy using `.env.test`:

```bash
FREEMODEL_API_KEYS="key1,key2" npm run test:live
```

The live check reads `FREEMODEL_API_KEYS` from `.env.test`, verifies `/v1/models` includes `claude-haiku-4-5-20251001`, and makes one streamed Haiku request through the proxy.

To test the deployed production proxy with Claude Code:

1. Create or load an account on `https://fm.bluealitas.com/account`, add at least one enabled upstream freemodel.dev key, and copy the generated internal `fmk_...` key.
2. Back up `~/.claude/settings.json`, then set Claude Code to the production proxy URL:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://fm.bluealitas.com",
    "ANTHROPIC_API_KEY": "fmk_...",
    "ANTHROPIC_AUTH_TOKEN": "fmk_..."
  },
  "apiKeyHelper": "printf '%s' 'fmk_...'"
}
```

3. Run:

```bash
claude -p "Reply with exactly OK." --model claude-haiku-4-5-20251001
```

Expected output is exactly `OK`. Do not commit real `fmk_...` keys.

## Privacy

* Visitor IDs are one-way SHA-256 hashes derived from IP + User-Agent; raw IPs are not stored.
* The old `fm_vid` cookie is expired on tracked page requests and is no longer used for visitor identity.
* No third-party analytics.

## Adding more endpoints later

When the OpenAI-compatible route is ready, add a second probe builder in `poller.js` (e.g. `buildOpenAIPayload`) and key it off target hostname or a new env var. The DB schema already partitions state by URL, so it'll just appear as another section in the UI.
