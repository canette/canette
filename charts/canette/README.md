# canette Helm chart

Deploys the canette builder, controller, and BuildKit daemon to an existing Kubernetes cluster. PostgreSQL and an in-cluster image registry are included and enabled by default but can be disabled in favour of external alternatives.

## Prerequisites

- Kubernetes 1.27+
- [Gateway API CRDs](https://gateway-api.sigs.k8s.io/guides/#installing-gateway-api) installed
- A Gateway API implementation (Traefik, Cilium, etc.)
- Helm 3.x
- Nodes running kernel ≥ 4.18 (5.11+ recommended) for rootless BuildKit

## Quick install

```bash
helm upgrade --install canette ./charts/canette \
  --set api.image="my-registry/canette-api:latest" \
  --set api.githubClientId="<client-id>" \
  --set api.githubClientSecret="<client-secret>" \
  --set ui.image="my-registry/canette-ui:latest" \
  --set ui.hostname="canette.example.com" \
  --set builder.image="my-registry/canette-builder:latest" \
  --set builder.builderImage="my-registry/canette-builder-image-build:latest" \
  --set builder.gitInitImage="my-registry/canette-builder-git-init:latest" \
  --set controller.image="my-registry/canette-controller:latest" \
  --set controller.pullRepo="registry.192-168-64-2.traefik.me:32500/" \
  --set controller.clusterDomain="apps.example.com"
```

The encryption key is auto-generated on first install and reused on every subsequent upgrade. See [Encryption key](#encryption-key) below.

## Values

### Required

| Value | Description |
|-------|-------------|
| `api.image` | Docker image for the API service (Bun + Hono) |
| `ui.image` | Docker image for the UI service (Next.js) |
| `ui.hostname` | Public hostname for the UI, e.g. `canette.example.com` — used for the HTTPRoute and CORS |
| `builder.image` | Docker image for the builder service (Go binary) |
| `builder.builderImage` | Pre-built railpack+buildctl+canette-config image used for build jobs |
| `controller.image` | Docker image for the controller service (Go binary) |
| `controller.pullRepo` | Registry URL reachable by the kubelet for image pulls, e.g. `registry.192-168-64-2.traefik.me:32500/` |
| `controller.clusterDomain` | Base domain for app URLs, e.g. `apps.example.com` |
| `builder.gitInitImage` | Override git-init image used as the init container in each build job |

### API

| Value | Default | Description |
|-------|---------|-------------|
| `api.githubClientId` | `""` | GitHub OAuth app client ID |
| `api.githubClientSecret` | `""` | GitHub OAuth app client secret |
| `api.authSecret` | auto | `BETTER_AUTH_SECRET` for signing sessions — auto-generated on first install |

### UI

| Value | Default | Description |
|-------|---------|-------------|
| `ui.hostname` | required | Public hostname, e.g. `canette.example.com` |

### Optional infrastructure

| Value | Default | Description |
|-------|---------|-------------|
| `postgres.enabled` | `true` | Deploy an in-cluster PostgreSQL instance |
| `postgres.password` | `canette` | PostgreSQL password (change in production) |
| `postgres.storage` | `1Gi` | PVC size for PostgreSQL data |
| `externalDatabase.url` | `""` | Connection string when `postgres.enabled=false` |
| `registry.enabled` | `true` | Deploy an in-cluster image registry |
| `registry.nodePort` | `32500` | NodePort for kubelet image pulls |
| `registry.username` | `""` | Enable basic auth on the in-cluster registry (both fields required) |
| `registry.password` | `""` | Password for the in-cluster registry |
| `externalRegistry.username` | `""` | Username for an external registry (when `registry.enabled=false`) |
| `externalRegistry.password` | `""` | Password for an external registry |

### BuildKit

| Value | Default | Description |
|-------|---------|-------------|
| `buildkit.image` | `moby/buildkit:v0.21.0-rootless` | BuildKit daemon image |
| `buildkit.resources` | 500m / 512Mi → 4 / 4Gi | CPU and memory requests/limits |
| `buildkit.registries` | `{}` | Extra registry trust entries added to `buildkitd.toml` |

### Builder

| Value | Default | Description |
|-------|---------|-------------|
| `builder.imageRepo` | auto | Registry URL build pods push to. Auto-derived from the in-cluster registry when `registry.enabled=true` |
| `builder.buildkitdAddr` | auto | BuildKit address. Auto-derived from the in-cluster service |
| `builder.pollInterval` | `5s` | How often to check for pending builds |
| `builder.maxConcurrent` | `3` | Maximum concurrent builds |

### Controller

| Value | Default | Description |
|-------|---------|-------------|
| `controller.gateway.name` | `can-gateway` | Name of the Gateway resource for HTTPRoutes |
| `controller.gateway.namespace` | `kube-system` | Namespace of the Gateway resource |
| `controller.pollInterval` | `5s` | How often to reconcile pending deployments |
| `controller.logTailInterval` | `10s` | How often to tail app logs |
| `controller.maxConcurrent` | `3` | Maximum concurrent deployments |

## Registry authentication

### In-cluster registry

By default the in-cluster registry accepts unauthenticated pushes (suitable for isolated dev clusters). To enable basic auth:

```yaml
registry:
  username: canette
  password: supersecret
```

When both values are set, the chart:
- Creates a bcrypt htpasswd Secret and configures the registry deployment to require auth
- Creates a docker config Secret (`canette-registry-auth`) and passes it to every build job automatically

### External registry

When using an external registry (`registry.enabled=false`), provide credentials so the builder can push images:

```yaml
registry:
  enabled: false
externalRegistry:
  username: myuser
  password: mytoken
builder:
  imageRepo: ghcr.io/myorg/
```

The chart creates a `canette-registry-auth` docker config Secret scoped to the registry host derived from `builder.imageRepo`.

## Encryption key

The AES-256-GCM key used to encrypt git credentials and app secrets at rest is auto-generated on first install and stored in the `canette-encryption-key` Secret in `canette-system`. Every subsequent `helm upgrade` reuses the existing key — no manual intervention required.

To provide your own key (e.g. during disaster recovery or cluster migration):

```bash
helm upgrade canette ./charts/canette --set encryptionKey="your-32-char-key"
```

> **Warning:** changing the key after secrets have been stored will break decryption of all existing credentials.

## Migrations

Database migrations run automatically at API startup. No separate image or Helm hook is needed. To opt into running migrations as a Helm pre-upgrade Job instead, set `migrations.enabled=true` in values — the API will then skip its inline migration run.

## Namespaces

The chart creates two namespaces:

| Namespace | Contents |
|-----------|----------|
| `canette-system` | Builder, controller, PostgreSQL, registry |
| `canette-build` | BuildKit daemon, build jobs (created at runtime) |

App deployments run in dynamically created `can-{id}-{slug}` namespaces managed by the controller.

## Upgrading

```bash
helm upgrade canette ./charts/canette --reuse-values
```

Migrations run automatically before the services restart.

## Uninstalling

```bash
helm uninstall canette
kubectl delete namespace canette-system canette-build
```

> **Warning:** this deletes the BuildKit state volume and all registry data. Back up any images you need before uninstalling.
