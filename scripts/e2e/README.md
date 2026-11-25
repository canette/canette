# Local Canette end-to-end test

This smoke test currently runs **only on macOS on Apple Silicon**. Both backends install the Helm chart from committed `HEAD`, build a small app from an in-cluster Git fixture, and check the node’s HTTPS registry pull and the app response through Traefik.

- [Lima](#set-up-the-lima-vm) runs single-node K3s in a reusable VM.
- [Apple Container](#apple-container-experimental) runs Kubernetes in Apple’s container runtime and shares its local image store.

## Set up the Lima VM

On an Apple Silicon Mac, install the host tools if needed:

```sh
brew install lima kubernetes-cli helm mkcert jq
```

From the repository root, create or start the dedicated Lima instance with K3s and Apple’s Virtualization.framework:

```sh
./scripts/e2e/macos-lima.sh --setup
```

The default instance is `canette-e2e`, with 4 CPUs, 6 GiB of memory, and a 20 GiB virtual disk. Actual host disk use depends on the branch, images, and build cache. The first test downloads build tools, public base images, and dependencies.

The script uses K3s’s bundled Traefik and `local-path` storage. It configures a Gateway API HTTPS listener, installs the test CA for registry pulls, and enables unprivileged user namespaces in the guest for Canette’s rootless BuildKit. The test chart requests 1 GiB for PostgreSQL and 2 GiB for the registry. These are PVC requests. The VM disk provides the shared capacity.

## Test a branch

Run from the repository root with the desired commit checked out and tracked files clean.

```sh
./scripts/e2e/macos-lima.sh --check
./scripts/e2e/macos-lima.sh
```

| Option | Behavior |
| --- | --- |
| No option | Builds and tests the branch, then removes the test release and its resources. |
| `--setup` | Creates the dedicated VM or starts an existing instance. |
| `--check` | Checks the checkout, kubeconfig, and running VM without changing them. |
| `--keep` | Keeps the test release, fixture, and images. If the test account was created, prints its dashboard login email and password. |
| `--cleanup` | Removes the retained test release, its fixture and build namespaces, PVCs, and image references. Runs from any directory. |
| `--lifecycle` | After the smoke test, runs the lifecycle scenarios. Combine with `--keep` to keep the release afterwards. See [Lifecycle scenarios](#lifecycle-scenarios). |

The script finds the kubeconfig exported by Lima when `KUBECONFIG` is unset. If you use a different instance name, set `LIMA_INSTANCE`. If you set `KUBECONFIG` explicitly, point it at that instance’s exported file. The script checks that both refer to the same node.

## Lifecycle scenarios

`--lifecycle` runs the Go tests in [`tests/lifecycle`](../../tests/lifecycle) against the release the smoke test installed (issue #330). They crash the controller at set points, stop and redeploy apps, and rename projects, then check what the API and Kubernetes report. Lima only for now. The run needs Go and takes about 30 minutes on top of the smoke test, mostly waiting for claims to expire.

```sh
./scripts/e2e/macos-lima.sh --lifecycle
LIFECYCLE_RUN='TestControllerCrash/after-claim' ./scripts/e2e/macos-lima.sh --lifecycle --keep
```

`LIFECYCLE_RUN` is passed to `go test -run`, and `LIFECYCLE_TIMEOUT` (default `60m`) to `-timeout`. The test output is saved with the failure diagnostics.

| Test | Checks |
| --- | --- |
| `TestControllerCrash` | The controller exits at the `after-claim`, `after-partial-apply`, `after-teardown-delete` and `after-app-delete` failpoints. After the restart, the deployment is failed as abandoned and a redeploy goes live, or the teardown or cleanup is retried and finishes. The history is kept, and a pending app cleanup keeps its slug taken. |
| `TestStopKeepsPVC` | Stop and redeploy keep the app's PVC (same UID). |
| `TestSlugChangeKeepsPVC` | A rename is refused while an app has a PVC volume, and the old namespace is kept while a PVC is left in it. |

The failpoints are set through the chart value `controller.failpoints`, with `helm upgrade --reuse-values`, which restarts the controller. Every project the tests create has a slug starting with the run's `smoke-<id>` project, so cleanup removes it with the run.

## Open a kept run in the browser

Run `./scripts/e2e/macos-lima.sh --keep` and save the printed dashboard credentials and app URL. The dashboard is at [ui.apps.canette-e2e.test](https://ui.apps.canette-e2e.test/login/email).

Export the kubeconfig and get the Gateway’s current IP. Use your instance name if it differs from the default.

```sh
export KUBECONFIG="${LIMA_HOME:-$HOME/.lima}/${LIMA_INSTANCE:-canette-e2e}/copied-from-guest/kubeconfig.yaml"
kubectl -n kube-system get gateway canette-e2e \
  -o jsonpath='{.status.addresses[0].value}{"\n"}'
```

Use `sudo nano /etc/hosts` to add the Gateway IP, the dashboard hostname, and the app hostname printed by the test. Replace both placeholders with your run’s values.

```text
<gateway-ip> ui.apps.canette-e2e.test <app-hostname>
```

Install the script’s test CA in the Mac trust store once:

```sh
CAROOT="${XDG_CACHE_HOME:-$HOME/.cache}/canette-e2e/${LIMA_INSTANCE:-canette-e2e}/ca" mkcert -install
```

Open the dashboard and sign in with the printed email and password to see the fixture project. The fixture app URL opens directly. For the next kept run, update the app hostname in `/etc/hosts`, and update the IP if Lima assigned a new one.

## Inspect the cluster

On the Mac, use the exported kubeconfig:

```sh
kubectl get pods,pvc -A
kubectl get gateway,httproute -A
kubectl get namespaces -l canette.dev/local-e2e=run
```

To SSH into the VM:

```sh
limactl shell canette-e2e
sudo k3s kubectl get nodes
sudo k3s kubectl get pods -A
sudo journalctl -u k3s -n 100 --no-pager
df -h /
```

On failure, the script prints a diagnostics directory with build logs, deployment status, and cluster events. With `--keep`, set `test_namespace` to the namespace printed by the script and inspect the release:

```sh
test_namespace='canette-e2e-<run-id>'
kubectl -n "$test_namespace" logs deployment/canette-api
kubectl -n "${test_namespace}-build" get jobs,pods
```

If disk space is tight, compare guest free space from `df -h /` with the VM’s allocated size from `du -sh "${LIMA_HOME:-$HOME/.lima}/canette-e2e"` on the Mac.

## Clean up or stop the VM

Clean up a kept run before starting another one. This deletes the retained test database and registry data. The Gateway, registry trust, and build cache are reused for the next run.

```sh
./scripts/e2e/macos-lima.sh --cleanup
```

Stop Lima when you’re done using the cluster:

```sh
limactl stop canette-e2e
```

Run `limactl delete canette-e2e` when you want to remove the VM and its disk, including the build cache.

## Apple Container (experimental)

Install [Apple Container](https://github.com/apple/container/releases) 1.7.1 or later on macOS 26 or later, then start its system service. Install the other host tools with Homebrew if needed. Run from a clean checkout of a trusted branch.

```sh
brew install kubernetes-cli helm mkcert jq
container system start
./scripts/e2e/macos-apple-container.sh
```

[macos-apple-container.sh](./macos-apple-container.sh) creates a dedicated single-node cluster named `canette-apple-e2e` with 4 CPUs, 6 GiB of memory, and the Apple shared image store. It builds the platform images with `container build` and installs Gateway API, Traefik, and the Local Path Provisioner in the test cluster. Kubernetes uses Apple Container’s bundled CNI. This smoke test covers application delivery and TLS.

The default run deletes the cluster and its recorded branch image tags on exit. Apple Container’s builder cache is shared with other local builds.

If disk space is tight, set `APPLE_E2E_BUILDER_CACHE_MB=3500` to have BuildKit trim unused cache toward 3,500 MB after each image build. This can evict cached layers from other Apple Container builds. The cache target covers BuildKit’s cache, and the node, images, and current build use additional disk space.

If the node cannot resolve Docker Hub, set `APPLE_E2E_DNS` to the IPv4 address of a DNS resolver reachable from the node. This sets DNS for the dedicated test node and passes the same address to Apple’s image builder. The command below uses Google’s public DNS.

```sh
APPLE_E2E_DNS=8.8.8.8 ./scripts/e2e/macos-apple-container.sh
```

| Option | Behavior |
| --- | --- |
| `--setup` | Creates the test cluster or reuses an existing running one. |
| `--check` | Checks the checkout and running test cluster. |
| `--keep` | Keeps the cluster for debugging and prints the test login if it was created. |
| `--cleanup` | Deletes the dedicated cluster, test volumes, and its recorded branch image tags. |

For browser access after `--keep`, use the Apple cluster’s kubeconfig and test CA.

```sh
apple_e2e_state="${XDG_CACHE_HOME:-$HOME/.cache}/canette-e2e/apple-container"
export KUBECONFIG="$apple_e2e_state/kubeconfig"
kubectl -n kube-system get gateway canette-apple-e2e \
  -o jsonpath='{.status.addresses[0].value}{"\n"}'
CAROOT="$apple_e2e_state/ca" mkcert -install
```

Map `ui.apps.canette-apple-e2e.test` and the printed app hostname to that IP in `/etc/hosts`. Sign in at the [Apple test dashboard](https://ui.apps.canette-apple-e2e.test/login/email) with the credentials printed by the script. To inspect the node, run `container exec -it canette-apple-e2e bash`.
