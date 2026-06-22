# freemodel.dev status

Live status and latency for the freemodel.dev LLM gateway, with lightweight unique visitor stats.

* **Polling**: probes run once on server start, then every 30 min if the last probe was 2xx, otherwise every minute until a 2xx is observed.
* **Targets**: `https://cc.freemodel.dev` and `https://api-cc.freemodel.dev` (Anthropic-compatible).
* **Models**: discovered dynamically from `GET /v1/models` on each target; configurable test set via `TEST_MODELS`.
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
| `GET /api/status` | JSON snapshot (target × model history, percentiles, uptime) |
| `GET /api/stats` | Unique visitor stats: today, active now, 30-day daily series, top countries |
| `GET /api/visits/recent?limit=50` | Recent visit log |
| `GET /api/health` | Liveness probe (checks DB connectivity) |
| `GET /api/config` | Public-safe runtime config |

## Configuration

| Env | Default | Notes |
|---|---|---|
| `DATABASE_URL` | _(required)_ | `postgres://user:pass@host:5432/db` |
| `TARGET_URLS` | `https://cc.freemodel.dev,https://api-cc.freemodel.dev` | Comma-separated. |
| `FREEMODEL_TOKEN` | _(empty)_ | Bearer token sent as `Authorization: Bearer …`. |
| `TEST_MODELS` | `claude-haiku-4-5-20251001` | `*` = test every discovered model. |
| `PROBE_TARGET_URL` | `https://api-cc.freemodel.dev` | Default target for `node probe.js` / `node poller.js`. |
| `PROBE_SESSION_TEXT` | `Calculate 1+1` | Session text embedded in the Claude Code title-generation probe prompt. |
| `CLAUDE_CODE_BILLING_HEADER` | `cc_version=2.1.185.042; cc_entrypoint=cli;` | Billing-header text embedded in the probe system prompt. |
| `INTERVAL_HEALTHY_MS` | `1800000` | 30 min — used when last probe was 2xx. |
| `INTERVAL_RETRY_MS` | `60000` | 1 min — used until a 2xx is observed. |
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

## Privacy

* Visitor IDs are one-way SHA-256 hashes derived from IP + User-Agent; raw IPs are not stored.
* The old `fm_vid` cookie is expired on tracked page requests and is no longer used for visitor identity.
* No third-party analytics.

## Adding more endpoints later

When the OpenAI-compatible route is ready, add a second probe builder in `poller.js` (e.g. `buildOpenAIPayload`) and key it off target hostname or a new env var. The DB schema already partitions state by URL, so it'll just appear as another section in the UI.
