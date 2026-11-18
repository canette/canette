# Local Canette end-to-end test

This smoke test currently runs **only on macOS on Apple Silicon**. [macos-lima.sh](./macos-lima.sh) tests committed `HEAD` on a single-node K3s cluster in Lima. It builds the Canette images into K3s’s containerd, installs the checkout’s Helm chart, and deploys a small app from an in-cluster Git fixture. It checks that the node pulls the app image over TLS and that Traefik serves the expected HTTPS response.

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

The script finds the kubeconfig exported by Lima when `KUBECONFIG` is unset. If you use a different instance name, set `LIMA_INSTANCE`. If you set `KUBECONFIG` explicitly, point it at that instance’s exported file. The script checks that both refer to the same node.

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
