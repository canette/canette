# Controller — local development

## What it does

The controller polls for deployments with `status='deploying'` (set by the builder after a successful image push) and reconciles them into the cluster using server-side apply. For each deployment it creates:

- A `Namespace` (`can-{projectSlug}`)
- A `Secret` with decrypted app secrets
- A `Deployment` running the built image
- A `Service` exposing app port (default 3000)
- An `HTTPRoute` routing `{appSlug}-{projectSlug}.{clusterDomain}` to the service

After the rollout succeeds it marks the deployment `live` and sets `apps.live_url`.

Runtime logs are streamed live from the pod by the `logstreamer` service — the controller does not poll or store them.

## Prerequisites

- k3d cluster running with buildkitd and registry deployed
- PostgreSQL running in-cluster with migrations applied (see `labs/postgres.yaml`)
- Builder has already completed a build and pushed an image (deployment `status='deploying'`)

Verify:
```bash
kubectl -n canette-build rollout status deploy/buildkitd
kubectl -n canette-system rollout status deploy/registry
```

## The image-pull problem

The builder pushes images tagged with the in-cluster DNS name:
```
registry.canette-system.svc.cluster.local:5000/project/app:git-abc1234
```

The kubelet resolves image names using the **node's** DNS, not kube-dns — so `.svc.cluster.local` names never resolve at image pull time. The registry is exposed as a NodePort on port **32500** to work around this.

`traefik.me` is a public wildcard DNS service that resolves any `*.traefik.me` hostname to the embedded IP. Use it to get a resolvable, stable hostname for the node:

```bash
# Get the node IP
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
echo $NODE_IP   # e.g. 192.168.64.2

# Derive the registry hostname (replace dots with dashes)
REGISTRY_HOST="registry.$(echo $NODE_IP | tr . -).traefik.me"
echo $REGISTRY_HOST   # e.g. registry.192-168-64-2.traefik.me
```

The kubelet will resolve `registry.192-168-64-2.traefik.me:32500` → `192.168.64.2:32500` (the NodePort), which reaches the registry.

### Configure containerd to use HTTP for the registry

The registry has no TLS, so containerd must be told to use plain HTTP for that address. On k3s (which k3d uses internally), edit the registries config **on each node**:

```bash
# Open a shell into the k3d node
docker exec -it <k3d-node-name> sh

# Create/edit the registries file
cat > /etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  "registry.192-168-64-2.traefik.me:32500":
    endpoint:
      - "http://registry.192-168-64-2.traefik.me:32500"
EOF

# Restart k3s so it picks up the change
systemctl restart k3s
exit
```

Find your node name with `docker ps | grep k3d`.

Verify containerd accepts the registry after restart:
```bash
# From inside the node, list images in the registry
curl -s http://registry.192-168-64-2.traefik.me:32500/v2/_catalog
```

## Find the Gateway name

The controller needs to know which Gateway to attach HTTPRoutes to. Check what's installed:

```bash
kubectl get gateway -A
```

With the canette Helm chart (which installs Traefik), you'll typically see:

```
NAMESPACE    NAME               CLASS    ADDRESS         PROGRAMMED
kube-system  traefik-gateway    traefik  192.168.64.2    True
```

Use `traefik-gateway` and `kube-system` as your `GATEWAY_NAME` and `GATEWAY_NAMESPACE`.

## Running locally

### 1. Start port-forwards

Keep these running in separate terminals before starting the controller:

```bash
# PostgreSQL
kubectl port-forward -n canette-system svc/postgres 5432:5432 &

# Registry (optional — useful for verifying images are present)
kubectl -n canette-system port-forward svc/registry 5000:5000 &
```

### 2. Export environment variables (from the monorepo root)

```bash
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
REGISTRY_HOST="registry.$(echo $NODE_IP | tr . -).traefik.me"

export ENCRYPTION_KEY=$(grep ENCRYPTION_KEY apps/api/.env | cut -d= -f2)
export DATABASE_URL=postgresql://canette:canette@localhost:5432/canette
export PULL_REPO=${REGISTRY_HOST}:32500/
export CLUSTER_DOMAIN=${NODE_IP//./-}.traefik.me
export GATEWAY_NAME=traefik-gateway
export GATEWAY_NAMESPACE=kube-system
```

With these settings, a deployed app will be reachable at:
```
http://{appSlug}-{projectSlug}.{NODE_IP//./-}.traefik.me
```

For example: `http://env-app-demo.192-168-64-2.traefik.me`

### 3. Run

```bash
cd apps/controller
go run .
```

The controller polls every 5 seconds for deployments with `status='deploying'`.

## Verifying a deployment

### Watch status in the DB

```bash
watch -n2 'psql $DATABASE_URL -c "SELECT id, status, error_message FROM deployments ORDER BY created_at DESC LIMIT 5"'
```

### Watch the applied K8s resources

```bash
# Replace <projectSlug> with your project slug
kubectl get namespace can-<projectSlug>
kubectl -n can-<projectSlug> get deploy,svc,httproute
kubectl -n can-<projectSlug> rollout status deploy/<appSlug>
```

### Check the applied manifest

The controller stores a redacted copy of what it applied. Retrieve it via the API or directly:

```bash
psql $DATABASE_URL -c \
  "SELECT applied_manifest FROM deployments ORDER BY created_at DESC LIMIT 1"
```

### Check the live URL

```bash
psql $DATABASE_URL -c "SELECT slug, live_url FROM apps"

# Once live, curl the app
curl http://<appSlug>-<projectSlug>.<NODE_IP_DASHED>.traefik.me
```

### Tail runtime logs (after the app is live)

```bash
# Via the SSE stream (requires the logstreamer running)
curl -s -N -b <cookie> "http://localhost:3001/api/v1/apps/<app-id>/logs/stream"

# Or directly from the pod
kubectl -n can-<projectSlug> logs -l canette.dev/app=<appSlug> -f
```

## Troubleshooting

**`ImagePullBackOff` / pod stuck pulling**

The kubelet can't reach the registry. Check:
1. The registries.yaml is configured correctly and k3s was restarted
2. `PULL_REPO` matches the hostname in registries.yaml exactly
3. The NodePort is reachable: `curl http://${REGISTRY_HOST}:32500/v2/_catalog`

**`HTTPRoute` not routing**

Check the Gateway is programmed and the route is accepted:
```bash
kubectl -n can-<projectSlug> describe httproute <appSlug>
```
Ensure `GATEWAY_NAME` and `GATEWAY_NAMESPACE` match the output of `kubectl get gateway -A`.

**Deployment stays at `deploying`**

The controller logs to stderr. Run `go run .` in a terminal and watch for errors. You can also check the controller's log lines in the DB:
```bash
psql $DATABASE_URL -c \
  "SELECT line FROM build_logs WHERE stream='controller' ORDER BY created_at DESC LIMIT 20"
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ENCRYPTION_KEY` | required | 64-char hex key. Must match the API server's key. |
| `DATABASE_URL` | `postgresql://canette:canette@localhost:5432/canette` | PostgreSQL connection string. |
| `PULL_REPO` | required | Registry address the kubelet can reach, e.g. `registry.192-168-64-2.traefik.me:32500/`. |
| `CLUSTER_DOMAIN` | required | Base domain for app URLs, e.g. `192-168-64-2.traefik.me`. |
| `GATEWAY_NAME` | `can-gateway` | Name of the Gateway resource HTTPRoutes attach to. |
| `GATEWAY_NAMESPACE` | `kube-system` | Namespace of the Gateway resource. |
| `BUILDER_NAMESPACE` | `canette-build` | Namespace where build jobs run (not app namespace). |
| `POLL_INTERVAL` | `5s` | How often to check for deploying deployments. |
| `MAX_CONCURRENT` | `3` | Maximum number of parallel reconciliations. |
| `KUBECONFIG` | `~/.kube/config` | Path to kubeconfig. Not needed when running in-cluster. |

## Running tests

```bash
# All packages
cd apps/controller && go test ./...

# Specific package, verbose output
cd apps/controller && go test -v ./internal/k8s/...

# With race detector
cd apps/controller && go test -race ./...
```

Each package has a skeleton test demonstrating the pattern. No database or cluster is required — all tests are pure unit tests.

## Building the binary

```bash
cd apps/controller
go build -o bin/controller .
```
