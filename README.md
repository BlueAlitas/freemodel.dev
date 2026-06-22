# freemodel.dev status

Live status & latency for the freemodel.dev LLM gateway.

* **Polling**: 30 min if the last probe was 2xx, otherwise every minute until a 2xx is observed.
* **Targets**: `https://cc.freemodel.dev` and `https://api-cc.freemodel.dev` (Anthropic-compatible).
* **Models**: discovered dynamically from `GET /v1/models` on each target; configurable test set via `TEST_MODELS`.
* **Storage**: a single JSON file at `data/status.json` (mounted as a Docker volume).

## Run locally

```bash
cp .env.example .env
# edit FREEMODEL_TOKEN, TEST_MODELS, etc.
npm install
npm start
# → http://localhost:3000
```

## Deploy to Dokploy

1. Push this repo to your git provider.
2. In Dokploy, **Create Service → Application → Docker Compose**, point it at the repo.
3. Set the environment variables in Dokploy's UI (notably `FREEMODEL_TOKEN`).
4. In **Domains**, add `fm.bluealitas.com` — Dokploy will write the Traefik labels and provision a Let's Encrypt certificate.
5. The compose file already includes the matching Traefik labels as a fallback if you deploy via raw compose.

## Routes

| Path | Description |
|---|---|
| `GET /` | Status page (this repo's frontend) |
| `GET /api/status` | JSON snapshot (target × model history, percentiles, uptime) |
| `GET /api/health` | Liveness probe for Traefik / Dokploy |
| `GET /api/config` | Public-safe runtime config |

## Configuration

| Env | Default | Notes |
|---|---|---|
| `TARGET_URLS` | `https://cc.freemodel.dev,https://api-cc.freemodel.dev` | Comma-separated. |
| `FREEMODEL_TOKEN` | _(empty)_ | Bearer token sent as `Authorization: Bearer …`. |
| `ANTHROPIC_VERSION` | `2023-06-01` | Sent as `anthropic-version` header. |
| `TEST_MODELS` | `claude-haiku-4-5-20251001` | Comma-separated. Set to `*` to test every discovered model. |
| `INTERVAL_HEALTHY_MS` | `1800000` | 30 min — used when last probe was 2xx. |
| `INTERVAL_RETRY_MS` | `60000` | 1 min — used until a 2xx is observed. |
| `MODEL_REFRESH_MS` | `21600000` | How often to re-fetch `/v1/models`. |
| `MAX_HISTORY` | `240` | Per (target, model) history cap. |
| `DATA_PATH` | `./data/status.json` | Persistence location. |

## Adding more endpoints later

When the OpenAI-compatible route is ready, extend `poller.js` to build an OpenAI-shaped probe payload (`POST /v1/chat/completions`) for a different target list and merge results into the same state shape — the server already keys history by `(target, model)`.