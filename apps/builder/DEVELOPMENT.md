# Builder — local development

## Prerequisites

- k3d cluster running with buildkitd deployed (`labs/buildkitd.yaml`)
- In-cluster registry running (`labs/registry.yaml`)
- PostgreSQL running in-cluster and migrations applied (see below)

Verify buildkitd and registry are ready:
```bash
kubectl -n canette-build rollout status deploy/buildkitd
kubectl -n canette-system rollout status deploy/registry
```

Deploy PostgreSQL and apply migrations if you haven't already:
```bash
kubectl apply -f labs/postgres.yaml
kubectl port-forward -n canette-system svc/postgres 5432:5432 &
bun run --cwd apps/api db:migrate
```

## Running locally

The builder reads from the shared PostgreSQL database. The image digest is captured directly from the build job logs — no registry HTTP call is made by the builder process.

Keep the PostgreSQL port-forward running in a separate terminal before starting the builder.

### 1. Export environment variables (from the monorepo root)

```bash
export ENCRYPTION_KEY=$(grep ENCRYPTION_KEY apps/api/.env | cut -d= -f2)
export DATABASE_URL=postgresql://canette:canette@localhost:5432/canette
export IMAGE_REPO=registry.canette-system.svc.cluster.local:5000/
export BUILDKITD_ADDR=tcp://buildkitd.canette-build.svc.cluster.local:1234
export BUILDER_IMAGE=registry.192-168-64-2.traefik.me:32500/canette-builder-image-build:latest
export GIT_INIT_IMAGE=registry.192-168-64-2.traefik.me:32500/canette-builder-git-init:latest
```

If the registry has authentication enabled (see `labs/registry.yaml`), also set:

```bash
export REGISTRY_AUTH_SECRET=registry-push-auth  # credentials for build pods to push images
```

The secret must exist in the `canette-build` namespace before running a build. Create it once:

```bash
# Option A — from a local docker login (captures all configured registries)
docker login registry.<node-ip>.traefik.me:<nodeport>
kubectl create secret generic registry-push-auth \
  --namespace canette-build \
  --from-file=.dockerconfigjson="${HOME}/.docker/config.json" \
  --type=kubernetes.io/dockerconfigjson

# Option B — create directly with explicit credentials
kubectl create secret docker-registry registry-push-auth \
  --namespace canette-build \
  --docker-server="registry.canette-system.svc.cluster.local:5000" \
  --docker-username="<user>" \
  --docker-password="<password>"
```

### 3. Run

```bash
cd apps/builder
go run .
```

The builder will poll every 5 seconds for deployments with `status='pending'` and process them.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ENCRYPTION_KEY` | — | **Required.** 64-char hex key. Must match the API server's key. |
| `DATABASE_URL` | `postgresql://canette:canette@localhost:5432/canette` | PostgreSQL connection string. |
| `IMAGE_REPO` | — | **Required.** Registry prefix, e.g. `registry.canette-system.svc.cluster.local:5000/` |
| `BUILDKITD_ADDR` | `tcp://buildkitd.canette-build.svc.cluster.local:1234` | Address of the buildkitd service. |
| `BUILDER_IMAGE` | — | **Required.** Full image reference for the pre-baked railpack+buildctl+build image. |
| `GIT_INIT_IMAGE` | — | **Required.** Full image reference for the git-init image (handles credential setup and cloning). |
| `BUILDER_NAMESPACE` | `canette-build` | Kubernetes namespace where build Jobs are created. |
| `REGISTRY_AUTH_SECRET` | — | Name of a `kubernetes.io/dockerconfigjson` Secret in `BUILDER_NAMESPACE` used to authenticate registry pushes from build pods. Leave unset for unauthenticated registries. |
| `LOG_LEVEL` | `info` | Zap log level: `debug`, `info`, `warn`, `error`. Set to `debug` to log full Job manifests before submission. |
| `POLL_INTERVAL` | `5s` | How often to check for pending deployments. |
| `MAX_CONCURRENT` | `3` | Maximum number of builds running at the same time. |
| `KUBECONFIG` | `~/.kube/config` | Path to kubeconfig. Not needed when running in-cluster. |

## Triggering a test build

Create an app and trigger a deployment via the UI, or use the API directly:

```bash
# 1. Get a project and app ID
curl -s -b <cookie> http://localhost:3001/api/v1/projects | jq '.items[0]'

# 2. Trigger a deployment
curl -s -b <cookie> -X POST http://localhost:3001/api/v1/apps/<app-id>/deployments \
  -H 'Content-Type: application/json' \
  -d '{"commitSha": "main", "commitMessage": "test build"}'
```

The builder will pick it up on the next poll cycle. Watch the status:

```bash
# Watch deployment status in the DB
watch -n2 'psql $DATABASE_URL -c "SELECT id, status, build_job_name, image_digest, error_message FROM deployments ORDER BY created_at DESC LIMIT 5"'

# Watch the build Job
kubectl -n canette-build get jobs -w

# Tail build logs
kubectl -n canette-build logs -l canette.dev/component=builder -c git-clone -f
kubectl -n canette-build logs -l canette.dev/component=builder -c image-build -f
```

## Running tests

```bash
# All packages
cd apps/builder && go test ./...

# Specific package, verbose output
cd apps/builder && go test -v ./cmd/canette-config/...

# With race detector
cd apps/builder && go test -race ./...
```

Tests are table-driven. The `cmd/canette-config` package has full coverage with YAML fixture files in `cmd/canette-config/testdata/`. Each other package has a single skeleton test demonstrating the pattern.

No database or cluster is required — all tests are pure unit tests.

## Building the binary

```bash
cd apps/builder
go build -o bin/builder .
```

## Structured log markers (`CAN_` lines)

The build containers communicate structured data back to the builder service by printing special-prefixed lines to stdout. The builder's log-tailing goroutine intercepts these lines in memory — they are never written to the `build_logs` table.

| Marker | Written by | Read by | Purpose |
|--------|-----------|---------|---------|
| `CAN_COMMIT_SHA=<sha>` | `canette-builder-git-init` (git-clone container) | Builder service → `deployments.commit_sha` | The actual resolved commit SHA after checkout. Needed because builds can be triggered from a branch name rather than a pinned SHA. |
| `CAN_IMAGE_REF=<ref>` | `canette-build` (image-build container) | Builder service → Trivy scan job + `MarkDeploying` | The full image reference (`registry/project/app:git-<sha>`) constructed once the SHA is known. Used to create the scan job and passed to the controller via the deployment record. |
| `CAN_IMAGE_DIGEST=<digest>` | `canette-build` (image-build container) | Builder service → `MarkDeploying` | The content-addressable digest (`sha256:...`) returned by BuildKit after the image is pushed. The controller pins this exact digest in the Kubernetes `Deployment` so rollouts are reproducible. |
| `CAN_CANETTE_CONFIG=<base64>` | `canette-build` (image-build container) | Builder service → `SetDeploymentCanetteConfig` | The raw `canette.yaml` from the repo, base64-encoded. Stored on the deployment record so the controller can apply repo-level overrides (port, resources, replicas) at deploy time. Omitted if no `canette.yaml` exists. |

The interception is handled in `internal/builder/builder.go` — see `tailLogs` and the `interceptors` map passed to `streamContainerLogs`. Any line matching a known prefix is captured into a string pointer and the `writeLine` function returns early without touching the database.
