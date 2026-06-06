# restaurant-watcher

A TypeScript script that scans a geographic bounding box for restaurant openings and closures using the **Google Places API (New)**. When changes are detected it generates a human-friendly announcement via a local **Ollama** model and posts it to a **Discord** channel.

Runs as a Kubernetes **CronJob** every Monday at 04:00 UTC, packaged as a Helm chart and published to GHCR. Versioning is fully automated with **semantic-release**.

---

## How it works

1. Divides the bounding box into an N×N grid and calls the Places Text Search API on each cell
2. Compares the results against a persisted registry JSON from the previous run
3. For every place that disappeared, makes a direct Places Details call to confirm it is permanently closed ("Ghost Hunter" check)
4. On the first run, seeds the registry without sending a notification unless `NOTIFY_ON_INITIAL_SCAN=true`
5. If anything changed on later runs, prompts Ollama to write a Romanian bullet-list announcement with emojis and posts it to Discord via webhook

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
| `MIN_CELL_DEPTH` | No | `0` | Force each grid cell to subdivide to this depth before saturation-based stopping |
| `MAX_CELL_DEPTH` | No | `6` | Maximum subdivision depth for saturated cells |
| `DATA_FILE` | No | `/data/city_center_registry.json` | Path for the persisted registry JSON |
| `OLLAMA_HOST` | No | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_MODEL` | No | `llama3.2` | Ollama model to use for announcements |
| `REQUEST_TIMEOUT_MS` | No | `30000` | Timeout for Google Places and Discord HTTP requests, in milliseconds |
| `OLLAMA_TIMEOUT_MS` | No | `60000` | Timeout for the Ollama generation request, in milliseconds |
| `NOTIFY_ON_INITIAL_SCAN` | No | `false` | Set to `true` to announce every restaurant found on the first scan instead of only seeding the registry |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook URL — omit to skip notifications |

> **Tip:** Google Places Text Search is capped and relevance-ranked, so larger cells can miss restaurants even when they return fewer than 20 results. Increase `GRID_SIZE` or set `MIN_CELL_DEPTH=1` for denser coverage. Saturated cells still subdivide automatically until they stop returning 20 results or hit `MAX_CELL_DEPTH`.

---

## Kubernetes / Helm

### Prerequisites

- [Vault Secrets Operator](https://developer.hashicorp.com/vault/docs/platform/k8s/vso) installed in the cluster
- A `VaultAuth` resource named `vaultauth-utility-services` in the target namespace, or override `vault.vaultAuthRef`
- The following keys written to Vault at `kv/utility-services/restaurant-watcher`, or override `vault.mount` / `vault.path`:

```sh
vault kv put kv/utility-services/restaurant-watcher \
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

The pod receives non-secret configuration from a ConfigMap. Secret values are wired explicitly from the Vault-synced Kubernetes Secret so the required Vault keys are visible in the rendered manifest:

| Environment variable | Kubernetes Secret key | Required |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | `GOOGLE_MAPS_API_KEY` | Yes |
| `DISCORD_WEBHOOK_URL` | `DISCORD_WEBHOOK_URL` | No |

### Key Helm values

| Value | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/floryn08/restaurant-watcher` | Container image |
| `image.tag` | `""` | Image tag. Empty means use the chart `appVersion` |
| `namespace` | `utility-services` | Namespace for rendered resources |
| `schedule` | `0 4 * * 1` | Cron schedule (Monday 04:00 UTC) |
| `activeDeadlineSeconds` | `1800` | Maximum runtime for each Job |
| `ttlSecondsAfterFinished` | `86400` | How long completed Jobs are retained |
| `config.*` | see `values.yaml` | Non-secret configuration |
| `config.minCellDepth` | `0` | Forced subdivision depth before saturation-based stopping |
| `config.maxCellDepth` | `6` | Maximum subdivision depth for saturated cells |
| `vault.enabled` | `true` | Render the VaultStaticSecret and secret-backed environment variables |
| `vault.mount` | `kv` | Vault KV mount |
| `vault.path` | `utility-services/restaurant-watcher` | Path within the mount |
| `vault.vaultAuthRef` | `vaultauth-utility-services` | Name of the `VaultAuth` resource |
| `vault.destination.name` | `restaurant-watcher` | Kubernetes Secret created by Vault Secrets Operator |
| `persistence.size` | `100Mi` | PVC/PV size for the registry JSON |
| `persistence.pv.enabled` | `false` | Render a static hostPath PersistentVolume |
| `persistence.pv.path` | `/srv/appdata/utility-services/restaurant-watcher` | Host path used when the static PV is enabled |
| `persistence.pv.storageClass` | `manual` | StorageClass used by the static PV and matching PVC |
| `volumePermissions.enabled` | `true` | Run an init container that makes the data volume writable by UID/GID 1001 |
| `volumePermissions.image` | `busybox:1.37` | Image used by the volume permission init container |

---

## CI / CD

| Trigger | Workflow | What happens |
|---|---|---|
| Pull request / push → `master` | `ci.yml` | Type-check, build, Helm lint, Helm render |
| Push to `master` | `release.yml` | Semantic release → Docker image pushed to GHCR → Helm chart pushed to GHCR as OCI artifact |

Versioning follows [Conventional Commits](https://www.conventionalcommits.org):

| Commit prefix | Release type |
|---|---|
| `fix:` | Patch |
| `chore:` | Patch |
| `refactor:` | Patch |
| `feat:` | Minor |
| `feat!:` / `BREAKING CHANGE:` | Major |
