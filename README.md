# freemodel.dev status

Live status, latency, reverse proxying, account API-key rotation, admin controls, and lightweight unique visitor stats for the freemodel.dev LLM gateway.

* **Polling**: probes run once on server start, then every minute until 50 consecutive probe requests are 2xx. Any failure resets that counter. After confirmation, probes run every 30 min.
* **Targets**: `https://cc.freemodel.dev` and `https://api-cc.freemodel.dev` (Anthropic-compatible).
* **Models**: discovered dynamically from `GET /v1/models` on each target; configurable test set via `TEST_MODELS`.
* **Proxy**: Anthropic-compatible `/v1/*` and `/proxy/v1/*` routes prefer T2 (`https://api-cc.freemodel.dev`), retry hidden upstream failures, and fall back to T0 (`https://cc.freemodel.dev`).
* **Accounts**: users can create a generated account ID, receive an internal API key, store multiple freemodel.dev keys by tier and priority, and delete the account.
* **Admin**: `/admin` uses `ADMIN_TOKEN` for account deletion, proxy enable/disable, active request visibility, request history, and charts.
* **Storage**: PostgreSQL (auto-creates tables on boot).
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
| `TARGET_URLS` | `https://cc.freemodel.dev,https://api-cc.freemodel.dev` | Comma-separated. |
| `FREEMODEL_TOKEN` | _(empty)_ | Bearer token sent as `Authorization: Bearer …`. |
| `PROXY_T2_URL` | `https://api-cc.freemodel.dev` | Preferred proxy upstream. |
| `PROXY_T0_URL` | `https://cc.freemodel.dev` | Proxy fallback upstream. |
| `PROXY_RETRIES_PER_CREDENTIAL` | `10` | Attempts per direct key, stored account key, or tier. |
| `PROXY_BODY_LIMIT` | `20mb` | Max buffered request body for retryable proxy requests. |
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
| `proxy_requests` | Proxy request metadata, final status, latency, attempt count, selected upstream, and error text. |
| `proxy_attempts` | Per-attempt tier, upstream, status, latency, and error metadata. |
| `system_settings` | Runtime flags such as `proxy_enabled`. |

## Testing

```bash
npm test
```

The deterministic test suite uses local mock upstreams and covers retry fallback, internal-key rotation, disabled-proxy behavior, and the no-body-storage invariant.

To smoke-test account/admin routes against the configured Postgres without touching upstream LLM APIs:

```bash
npm run test:db
```

To run a live low-cost check through the local proxy using `.env.test`:

```bash
FREEMODEL_API_KEYS="key1,key2" npm run test:live
```

The live check reads `FREEMODEL_API_KEYS` from `.env.test`, verifies `/v1/models` includes `claude-haiku-4-5-20251001`, and makes one streamed Haiku request through the proxy.

## Privacy

* Visitor IDs are one-way SHA-256 hashes derived from IP + User-Agent; raw IPs are not stored.
* The old `fm_vid` cookie is expired on tracked page requests and is no longer used for visitor identity.
* No third-party analytics.

## Adding more endpoints later

When the OpenAI-compatible route is ready, add a second probe builder in `poller.js` (e.g. `buildOpenAIPayload`) and key it off target hostname or a new env var. The DB schema already partitions state by URL, so it'll just appear as another section in the UI.
