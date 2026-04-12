# restaurant-watcher

A TypeScript script that scans a geographic bounding box for restaurant openings and closures using the **Google Places API (New)**. When changes are detected it generates a human-friendly announcement via a local **Ollama** model and posts it to a **Discord** channel.

Runs as a Kubernetes **CronJob** every Monday at 04:00 UTC, packaged as a Helm chart and published to GHCR. Versioning is fully automated with **semantic-release**.

---

## How it works

1. Divides the bounding box into an N×N grid and calls the Places Text Search API on each cell
2. Compares the results against a persisted registry JSON from the previous run
3. For every place that disappeared, makes a direct Places Details call to confirm it is permanently closed ("Ghost Hunter" check)
4. If anything changed, prompts Ollama to write a short announcement and posts it to Discord via webhook

---

## Local development

### Prerequisites

- Node.js ≥ 24
- A [Google Places API (New)](https://developers.google.com/maps/documentation/places/web-service/overview) key with the **Places API** enabled
- (Optional) [Ollama](https://ollama.com) running locally with a model pulled (e.g. `ollama pull llama3.2`)
- (Optional) A Discord webhook URL

### Setup

```sh
cp .env.example .env
# Fill in the required values in .env
npm ci
npm run dev          # runs via tsx, no build step needed
```

### Build

```sh
npm run build        # compiles src/ → dist/
npm start            # runs the compiled output
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` for local use.

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Yes | — | Google Places API key |
| `SW_LAT` / `SW_LNG` | Yes | — | South-west corner of the bounding box |
| `NE_LAT` / `NE_LNG` | Yes | — | North-east corner of the bounding box |
| `GRID_SIZE` | No | `3` | Number of grid cells per axis (higher = finer scan, more API calls) |
| `DATA_FILE` | No | `/data/city_center_registry.json` | Path for the persisted registry JSON |
| `OLLAMA_HOST` | No | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_MODEL` | No | `llama3.2` | Ollama model to use for announcements |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook URL — omit to skip notifications |

> **Tip:** If a grid sector returns exactly 20 results the script warns you — the Places API caps responses at 20. Increase `GRID_SIZE` to subdivide that area further.

---

## Kubernetes / Helm

### Prerequisites

- [Vault Secrets Operator](https://developer.hashicorp.com/vault/docs/platform/k8s/vso) installed in the cluster
- A `VaultAuth` resource named `default` in the target namespace
- The following secrets written to Vault at `secret/restaurant-watcher/config`:

```sh
vault kv put secret/restaurant-watcher/config \
  GOOGLE_MAPS_API_KEY=<your-key> \
  DISCORD_WEBHOOK_URL=<your-webhook>
```

### Install

```sh
helm install restaurant-watcher \
  oci://ghcr.io/<owner>/charts/restaurant-watcher \
  --version <version> \
  --set image.repository=ghcr.io/<owner>/restaurant-watcher \
  --set config.swLat=45.638 \
  --set config.swLng=25.584 \
  --set config.neLat=45.646 \
  --set config.neLng=25.597
```

Or override values in a file:

```sh
helm install restaurant-watcher \
  oci://ghcr.io/<owner>/charts/restaurant-watcher \
  --version <version> \
  -f my-values.yaml
```

### Key Helm values

| Value | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/OWNER/restaurant-watcher` | Container image |
| `image.tag` | `latest` | Image tag |
| `schedule` | `0 4 * * 1` | Cron schedule (Monday 04:00 UTC) |
| `config.*` | see `values.yaml` | Non-secret configuration |
| `vault.mount` | `secret` | Vault KV mount |
| `vault.path` | `restaurant-watcher/config` | Path within the mount |
| `vault.vaultAuthRef` | `default` | Name of the `VaultAuth` resource |
| `persistence.size` | `100Mi` | PVC size for the registry JSON |

---

## CI / CD

| Trigger | Workflow | What happens |
|---|---|---|
| Pull request → `master` | `ci.yml` | Type-check + build |
| Push to `master` | `release.yml` | Semantic release → Docker image pushed to GHCR → Helm chart pushed to GHCR as OCI artifact |

Versioning follows [Conventional Commits](https://www.conventionalcommits.org):

| Commit prefix | Release type |
|---|---|
| `fix:` | Patch |
| `feat:` | Minor |
| `feat!:` / `BREAKING CHANGE:` | Major |
