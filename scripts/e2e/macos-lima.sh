#!/usr/bin/env bash
# Run a Canette Git-to-HTTPS smoke test on a Lima K3s VM on Apple Silicon.
set -euo pipefail
umask 077

usage() {
    cat <<'USAGE'
Usage: scripts/e2e/macos-lima.sh [--setup | --check | --keep | --cleanup]

Requires macOS on Apple Silicon. Run tests from a Canette checkout to build
committed HEAD for linux/arm64.
  --setup    Create or start the dedicated Lima K3s VM. Runs from any directory.
  --check    Check the checkout and running cluster without changing either.
  --keep     Keep the test release and print its dashboard login.
  --cleanup  Delete retained test releases, fixture namespaces, PVCs, and images.
             Run from any directory.

Environment:
  LIMA_INSTANCE   Dedicated Lima instance (default: canette-e2e)
  KUBECONFIG      Its single kubeconfig file (default: the Lima-exported file)

The first run downloads build dependencies, enables Traefik Gateway API, and
configures registry trust and rootless builds in the guest. Test releases
and image tags are cleaned up by default. The VM, Gateway and build cache
are reused. No Mac hosts file or system trust-store changes are needed.
USAGE
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*" >&2; }

check_only=false
keep=false
cleanup_only=false
setup_only=false
case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    --setup) setup_only=true ;;
    --check) check_only=true ;;
    --keep) keep=true ;;
    --cleanup) cleanup_only=true ;;
    '') ;;
    *) usage >&2; exit 2 ;;
esac
(( $# <= 1 )) || die 'Expected at most one option.'

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] ||
    die 'Run this script on an Apple Silicon Mac using a native shell.'
command -v limactl >/dev/null || die 'Missing command: limactl'

instance="${LIMA_INSTANCE:-canette-e2e}"
[[ "$instance" =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Invalid Lima instance name.'
lima_kubeconfig="${LIMA_HOME:-$HOME/.lima}/$instance/copied-from-guest/kubeconfig.yaml"
host_lock="${TMPDIR:-/tmp}/canette-e2e-$instance.lock"
lock_acquired=false

acquire_lock() {
    mkdir "$host_lock" 2>/dev/null ||
        die "Another run is active for $instance. If it was killed abruptly, remove $host_lock."
    lock_acquired=true
}

release_lock() {
    if "$lock_acquired"; then
        rmdir "$host_lock"
    fi
}

if "$setup_only"; then
    trap release_lock EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    acquire_lock
    instance_status="$(limactl list --format '{{.Name}} {{.Status}}' |
        awk -v name="$instance" '$1 == name { print $2 }')"
    case "$instance_status" in
        Running) step "Reusing running Lima instance $instance" ;;
        '') limactl start --yes --name "$instance" --vm-type=vz --network=vzNAT \
                --cpus=4 --memory=6 --disk=20 template:k3s ;;
        *) limactl start --yes "$instance" ;;
    esac
    [[ -r "$lima_kubeconfig" ]] || die "Lima has not exported a K3s kubeconfig at $lima_kubeconfig"
    printf 'Kubeconfig: %s\n' "$lima_kubeconfig"
    exit 0
fi

kubeconfig="${KUBECONFIG:-$lima_kubeconfig}"
[[ -r "$kubeconfig" ]] || die "Kubeconfig is unreadable: $kubeconfig. Run --setup to start the test VM."
for command in kubectl helm jq; do
    command -v "$command" >/dev/null || die "Missing command: $command"
done

kube() { kubectl --kubeconfig "$kubeconfig" "$@"; }
vm() { limactl shell --workdir / "$instance" "$@"; }

gateway_namespace=kube-system
gateway_name=canette-e2e
domain=apps.canette-e2e.test
ui_host="ui.$domain"
registry_host="registry.$domain"
tls_secret=canette-e2e-tls
infra_label=canette.dev/local-e2e
image_repo=canette-e2e.invalid/canette
release=canette

run_namespaces() {
    kube --request-timeout=10s get namespace -l "$infra_label=run" -o json
}

remove_run_images() {
    vm sudo bash -s -- "$image_repo" "$registry_host" "$1" <<'GUEST'
set -euo pipefail
platform_repo="$1"
registry_host="$2"
run_id="$3"
refs="$(k3s ctr -n k8s.io images ls -q)"
while IFS= read -r ref; do
    if [[ "$ref" == "$platform_repo/"* && "${ref##*:}" =~ ^git-[a-f0-9]{12}-$run_id$ ]] ||
        [[ "$ref" == "$registry_host/smoke-$run_id/"* ]]; then
        k3s ctr -n k8s.io images rm "$ref"
    fi
done <<<"$refs"
GUEST
}

remove_run() {
    local target="$1" target_id
    [[ "$target" =~ ^canette-e2e-([a-f0-9]{8})$ ]] ||
        { printf 'Invalid test namespace: %s\n' "$target" >&2; return 1; }
    target_id="${BASH_REMATCH[1]}"

    kube delete namespace -l "app.kubernetes.io/managed-by=canette,canette.dev/project=smoke-$target_id" \
        --ignore-not-found --timeout=90s || return
    helm --kubeconfig "$kubeconfig" uninstall "$release" -n "$target" --ignore-not-found --timeout 90s || return
    # Keep the run label available for a retry until image removal succeeds.
    remove_run_images "$target_id" || return
    kube delete namespace "$target" "$target-build" --ignore-not-found --timeout=90s
}

step "Checking K3s on $instance"
nodes="$(kube --request-timeout=10s get nodes -o json)"
node_uid="$(jq -er '
    .items | select(length == 1) | .[0]
    | select(.status.nodeInfo.architecture == "arm64")
    | select(.status.nodeInfo.kubeletVersion | contains("+k3s"))
    | .metadata.uid
' <<<"$nodes")" || die 'Expected one ARM64 K3s node.'
guest_uid="$(vm sudo k3s kubectl --request-timeout=10s get nodes -o jsonpath='{.items[0].metadata.uid}')"
[[ "$node_uid" == "$guest_uid" ]] || die 'KUBECONFIG points to a different cluster than LIMA_INSTANCE.'

if "$cleanup_only"; then
    trap release_lock EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    acquire_lock
    targets="$(run_namespaces | jq -r '.items[].metadata.name')"
    if [[ -z "$targets" ]]; then
        printf 'No retained Canette runs on %s.\n' "$instance"
        exit 0
    fi
    while IFS= read -r target; do
        step "Removing retained Canette run $target"
        remove_run "$target"
    done <<<"$targets"
    exit 0
fi

for command in git mkcert curl ssh-keygen openssl tar; do
    command -v "$command" >/dev/null || die "Missing command: $command"
done

repo="$(git rev-parse --show-toplevel)" || die 'Run from a cloned Canette repository.'
cd "$repo"
sha="$(git rev-parse --verify HEAD)"
git diff --quiet HEAD -- || die 'Commit or stash tracked changes first. The test builds committed HEAD.'
git cat-file -e HEAD:charts/canette/Chart.yaml || die 'Canette chart missing from HEAD.'
git cat-file -e HEAD:scripts/build-images.sh || die 'Canette image build script missing from HEAD.'

images=(
    canette-api:apps/api/Dockerfile
    canette-ui:apps/ui/Dockerfile
    canette-builder:apps/builder/Dockerfile
    canette-builder-git-init:apps/builder/images/git-init/Dockerfile
    canette-builder-image-build:apps/builder/images/image-build/Dockerfile
    canette-controller:apps/controller/Dockerfile
    canette-logstreamer:apps/logstreamer/Dockerfile
    canette-authgate:apps/authgate/Dockerfile
)
for image in "${images[@]}"; do
    git cat-file -e "HEAD:${image#*:}" || die "Missing Dockerfile for ${image%%:*}."
done

step "Checking the checkout (${sha:0:12}) and cluster readiness"
jq -e 'any(.items[0].status.conditions[]; .type == "Ready" and .status == "True")' <<<"$nodes" >/dev/null ||
    die 'The K3s node is not ready.'
node_ip="$(vm ip -4 -o addr show dev lima0 | awk 'NR == 1 { split($4, a, "/"); print a[1] }')"
[[ "$node_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'No IPv4 address on lima0. Start Lima with --network=vzNAT.'
kube --request-timeout=10s -n "$gateway_namespace" get helmchart traefik >/dev/null
kube --request-timeout=10s get storageclass local-path >/dev/null
vm python3 -c 'import yaml' || die 'Install python3-yaml inside the Lima VM.'

existing_traefik="$(kube --request-timeout=10s -n "$gateway_namespace" get helmchartconfig traefik --ignore-not-found -o json)"
if [[ -n "$existing_traefik" ]]; then
    jq -e --arg key "$infra_label" '.metadata.labels[$key] == "true"' <<<"$existing_traefik" >/dev/null ||
        die 'Traefik already has a HelmChartConfig owned by another setup. Use a dedicated K3s instance.'
fi
vm df -h /
if "$check_only"; then
    printf 'Preflight passed for %s at %s\n' "$instance" "$node_ip"
    exit 0
fi

run_id="$(openssl rand -hex 4)"
namespace="canette-e2e-$run_id"
build_namespace="$namespace-build"
tag="git-${sha:0:12}-$run_id"
project_slug="smoke-$run_id"
app_slug=hello
app_host="$app_slug-$project_slug.$domain"
git_host="fixture-git.$namespace.svc.cluster.local"
marker="canette-e2e-$run_id"
work="$(mktemp -d "${TMPDIR:-/tmp}/canette-e2e.XXXXXXXX")"
guest_work=''
release_created=false
images_started=false
project_id=''
deployment_id=''
account_created=false
stage=setup

diagnostics() {
    local logs
    logs="$(mktemp -d "${TMPDIR:-/tmp}/canette-e2e-logs.XXXXXXXX")" || return
    for file in platform-build.log helm.log deployment.json; do
        [[ ! -f "$work/$file" ]] || cp "$work/$file" "$logs/"
    done
    {
        printf 'Commit: %s\nStage: %s\n' "$sha" "$stage"
        kube --request-timeout=10s get gateway,httproute,pvc,jobs,pods -A -o wide
        kube --request-timeout=10s get gateway,httproute -A -o yaml
        kube --request-timeout=10s get events -A --sort-by=.metadata.creationTimestamp
        vm df -h /
        vm sudo journalctl -u canette-e2e-buildkit --no-pager -n 80
    } >"$logs/cluster.log" 2>&1
    if "$release_created"; then
        for ns in "$namespace" "$build_namespace"; do
            {
                kube --request-timeout=10s -n "$ns" describe pods
                kube --request-timeout=10s -n "$ns" get pods -o name |
                    while IFS= read -r pod; do
                        printf '\n--- %s ---\n' "$pod"
                        kube --request-timeout=10s -n "$ns" logs "$pod" --all-containers --prefix --tail=100
                    done
            } >"$logs/$ns.log" 2>&1
        done
    fi
    if [[ -n "$deployment_id" ]]; then
        api GET "/api/v1/deployments/$deployment_id/logs" >"$logs/canette-build.json" 2>/dev/null
    fi
    printf 'Failure diagnostics: %s\n' "$logs" >&2
}

cleanup() {
    local status=$?
    trap - EXIT
    set +e
    if (( status != 0 )); then
        printf '\nTest failed during %s (exit %s).\n' "$stage" "$status" >&2
        diagnostics
    fi
    if "$keep" && "$release_created"; then
        printf 'Kept test release in %s (images tagged %s).\n' "$namespace" "$tag" >&2
        if "$account_created"; then
            printf '\nCanette dashboard: https://%s/login/email\nUsername (email): %s\nPassword: %s\n' \
                "$ui_host" "$email" "$password"
        fi
    else
        if "$release_created"; then
            remove_run "$namespace" || { printf 'Cleanup failed. Retry with --cleanup.\n' >&2; status=1; }
        elif "$images_started"; then
            remove_run_images "$run_id" || { printf 'Could not remove test image tags for %s.\n' "$run_id" >&2; status=1; }
        fi
    fi
    if [[ "$guest_work" =~ ^/var/tmp/canette-e2e\.[[:alnum:]]+$ ]]; then
        vm rm -rf -- "$guest_work"
    fi
    rm -rf -- "$work"
    release_lock
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_lock
kept_namespace="$(run_namespaces |
    jq -r '.items[] | select(.metadata.deletionTimestamp == null) | .metadata.name')"
[[ -z "$kept_namespace" ]] || die "A previous run is still using the test hostnames in $kept_namespace. Run --cleanup before starting another run."

# Keep the private runner CA separate from any CA already used on this Mac.
ca_dir="${XDG_CACHE_HOME:-$HOME/.cache}/canette-e2e/$instance/ca"
mkdir -p "$ca_dir"
if ! CAROOT="$ca_dir" mkcert -cert-file "$work/tls.crt" -key-file "$work/tls.key" "*.$domain" >"$work/mkcert.log" 2>&1; then
    cat "$work/mkcert.log" >&2
    die 'Could not issue the test Gateway certificate.'
fi
ca="$ca_dir/rootCA.pem"
cookie="$work/session.cookies"
touch "$cookie"

https() {
    local host="$1"
    shift
    curl --silent --show-error --noproxy '*' --connect-timeout 5 --max-time 25 \
        --cacert "$ca" --resolve "$host:443:$node_ip" "$@"
}

api() {
    local method="$1" path="$2" code
    shift 2
    code="$(https "$ui_host" --request "$method" --header "Origin: https://$ui_host" \
        --cookie "$cookie" --cookie-jar "$cookie" --output "$work/response.json" \
        --write-out '%{http_code}' "$@" "https://$ui_host$path")" || return
    if [[ "$code" != 2?? ]]; then
        printf '%s %s returned HTTP %s\n' "$method" "$path" "$code" >&2
        jq -r '[.code, .error, .message] | map(select(type == "string")) | join(" ")' "$work/response.json" >&2 || true
        return 1
    fi
    cat "$work/response.json"
}

post_json() {
    api POST "$1" --header 'Content-Type: application/json' --data-binary @-
}

retry() {
    local timeout="$1"
    shift
    local deadline=$((SECONDS + timeout))
    until "$@"; do
        (( SECONDS < deadline )) || return 1
        sleep 3
    done
}

stage=registry-trust
step 'Configuring the registry CA and rootless BuildKit in the guest'
# Use a single remote Python invocation to preserve unrelated registry entries.
node_config="$(jq -n --arg host "$registry_host" --arg ip "$node_ip" --rawfile ca "$ca" '{host:$host,ip:$ip,ca:$ca}')"
printf '%s\n' "$node_config" | vm sudo python3 -c '
import json
import pathlib
import subprocess
import sys
import yaml

settings = json.load(sys.stdin)
root = pathlib.Path("/etc/rancher/k3s")
root.mkdir(parents=True, exist_ok=True)
ca_file = root / "canette-e2e-registry-ca.pem"
registries = root / "registries.yaml"
hosts = pathlib.Path("/etc/hosts")
marker = " # managed by canette-e2e"
host = settings["host"]
ip = settings["ip"]
original_hosts = hosts.read_text()
lines = original_hosts.splitlines()
for line in lines:
    fields = line.split("#", 1)[0].split()
    if host in fields[1:] and not line.endswith(marker):
        sys.exit(f"{host} already has an unmanaged /etc/hosts entry")
new_hosts = "\n".join([line for line in lines if not line.endswith(marker)]
                      + [f"{ip} {host}{marker}"]) + "\n"

old_yaml = registries.read_text() if registries.exists() else ""
config = yaml.safe_load(old_yaml) or {}
configs = config.setdefault("configs", {})
entry = configs.get(host, {})
old_ca = entry.get("tls", {}).get("ca_file")
if entry and old_ca != str(ca_file):
    sys.exit(f"{host} already has an unmanaged registry configuration")
entry.setdefault("tls", {})["ca_file"] = str(ca_file)
configs[host] = entry
old_pem = ca_file.read_text() if ca_file.exists() else ""
restart = old_ca != str(ca_file) or old_pem != settings["ca"]

if new_hosts != original_hosts:
    hosts.write_text(new_hosts)
if old_pem != settings["ca"]:
    ca_file.write_text(settings["ca"])
if old_ca != str(ca_file):
    registries.write_text(yaml.safe_dump(config, sort_keys=False))
    registries.chmod(0o600)

userns = pathlib.Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
if userns.exists() and userns.read_text().strip() != "0":
    subprocess.run(["sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=0"], check=True)
if restart:
    subprocess.run(["systemctl", "restart", "k3s"], check=True)
'
kube wait --for=condition=Ready node --all --timeout=120s

stage=gateway
step 'Configuring Traefik Gateway API and HTTPS'
kube -n "$gateway_namespace" create secret tls "$tls_secret" \
    --cert="$work/tls.crt" --key="$work/tls.key" --dry-run=client -o yaml | kube apply -f -
kube apply -f - <<YAML
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: $gateway_namespace
  labels:
    $infra_label: "true"
spec:
  valuesContent: |
    providers:
      kubernetesGateway:
        enabled: true
    gateway:
      enabled: true
      name: $gateway_name
      listeners:
        websecure:
          port: 8443
          hostname: "*.$domain"
          protocol: HTTPS
          namespacePolicy:
            from: All
          certificateRefs:
            - kind: Secret
              name: $tls_secret
YAML

gateway_exists() {
    [[ "$(kube --request-timeout=8s -n "$gateway_namespace" get gateway "$gateway_name" --ignore-not-found -o name 2>/dev/null)" != '' ]]
}
retry 180 gateway_exists || die 'Traefik did not create the test Gateway.'
kube -n "$gateway_namespace" wait --for=condition=Programmed "gateway/$gateway_name" --timeout=120s

stage=platform-images
step 'Building the eight platform images directly into K3s containerd'
guest_work="$(vm mktemp -d /var/tmp/canette-e2e.XXXXXXXX)"
[[ "$guest_work" =~ ^/var/tmp/canette-e2e\.[[:alnum:]]+$ ]] || die 'Invalid guest scratch path.'
mkdir -p "$work/chart"
git archive "$sha" charts/canette | tar -xf - -C "$work/chart"
git archive "$sha" | vm tar -xf - -C "$guest_work"
images_started=true
vm sudo bash -s -- "$guest_work" "$image_repo" "$tag" "${images[@]}" <<'GUEST' 2>&1 | tee "$work/platform-build.log"
set -euo pipefail
source_dir="$1"
image_repo="$2"
tag="$3"
shift 3

tools=/var/lib/canette-e2e/buildkit-v0.35.0
socket=unix:///run/canette-e2e-buildkit.sock
if [[ ! -x "$tools/bin/buildkitd" || ! -x "$tools/bin/buildctl" ]]; then
    archive=buildkit-v0.35.0.linux-arm64.tar.gz
    cd "$source_dir"
    curl --fail --location --silent --show-error --retry 2 --max-time 180 --output "$archive" \
        "https://github.com/moby/buildkit/releases/download/v0.35.0/$archive"
    printf '%s  %s\n' e33872fbc13d7858f2fd4e434697e9a1aa03347a6fe13f86a58c9c3b0e711286 "$archive" | sha256sum -c -
    mkdir -p "$tools"
    tar -xzf "$archive" -C "$tools" bin/buildctl bin/buildkitd
    rm -f "$archive"
fi

if ! systemctl is-active --quiet canette-e2e-buildkit; then
    cat >"$tools/buildkitd.toml" <<'TOML'
[worker.oci]
  enabled = false

[worker.containerd]
  enabled = true
  address = "/run/k3s/containerd/containerd.sock"
  namespace = "k8s.io"
  gc = true
  reservedSpace = "1GB"
  maxUsedSpace = "4GB"
  minFreeSpace = "3GB"
  max-parallelism = 2
TOML
    systemd-run --unit=canette-e2e-buildkit "$tools/bin/buildkitd" \
        --config "$tools/buildkitd.toml" --root /var/lib/canette-e2e/build-cache --addr "$socket"
fi
timeout 45 "$tools/bin/buildctl" --addr "$socket" --wait debug workers
cd "$source_dir"
for image in "$@"; do
    ref="$image_repo/${image%%:*}:$tag"
    printf '\nBuilding %s\n' "$ref"
    "$tools/bin/buildctl" --addr "$socket" build --progress plain \
        --frontend dockerfile.v0 --local context=. --local dockerfile=. \
        --opt "filename=${image#*:}" --opt platform=linux/arm64 \
        --output "type=image,name=$ref,store=true,unpack=true"
    timeout 15 bash -c 'until k3s crictl inspecti "$1" >/dev/null 2>&1; do sleep 1; done' -- "$ref" ||
        { printf 'K3s containerd could not see %s\n' "$ref" >&2; exit 1; }
done
GUEST

stage=install
step "Installing Canette in $namespace"
kube create namespace "$namespace" --dry-run=client -o json |
    jq --arg label "$infra_label" '.metadata.labels[$label] = "run"' | kube create -f -
release_created=true
helm --kubeconfig "$kubeconfig" install "$release" "$work/chart/charts/canette" \
    -n "$namespace" --wait --timeout 8m \
    --set-string "domain=$domain" --set-string "ui.hostname=$ui_host" \
    --set-string "controller.gateway.name=$gateway_name" \
    --set-string "controller.gateway.namespace=$gateway_namespace" \
    --set-string "image.repo=$image_repo" --set-string "image.tag=$tag" \
    --set-string postgres.persistence.size=1Gi --set-string registry.persistence.size=2Gi \
    2>&1 | tee "$work/helm.log"
kube -n "$namespace" wait '--for=jsonpath={.status.phase}=Bound' \
    pvc/postgres-data pvc/registry-data --timeout=60s

registry_reachable() {
    [[ "$(https "$registry_host" -o /dev/null -w '%{http_code}' "https://$registry_host/v2/" 2>/dev/null)" == 401 ]]
}
retry 90 registry_reachable || die 'The host did not reach the authenticated registry over HTTPS.'
guest_registry_reachable() {
    [[ "$(vm curl --silent --show-error --noproxy '*' --max-time 8 \
        --cacert /etc/rancher/k3s/canette-e2e-registry-ca.pem \
        -o /dev/null -w '%{http_code}' "https://$registry_host/v2/" 2>/dev/null)" == 401 ]]
}
retry 30 guest_registry_reachable || die 'The K3s node could not resolve or verify the registry HTTPS endpoint.'
retry 60 api GET /api/v1/signup-settings >/dev/null || die 'The UI HTTPS route did not proxy requests to the API.'

stage=git-fixture
step 'Creating a local Git repository and SSH service'
mkdir "$work/fixture"
cat >"$work/fixture/Dockerfile" <<'DOCKERFILE'
FROM busybox:1.37.0
COPY index.html /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
DOCKERFILE
printf '%s\n' "$marker" >"$work/fixture/index.html"
git -C "$work/fixture" init -q -b main
git -C "$work/fixture" add Dockerfile index.html
git -C "$work/fixture" -c user.name='Canette E2E' -c user.email=fixture@example.test \
    -c commit.gpgsign=false commit -qm "Canette E2E fixture $run_id"
fixture_sha="$(git -C "$work/fixture" rev-parse HEAD)"
git -C "$work/fixture" bundle create "$work/fixture.bundle" main
ssh-keygen -q -t ed25519 -N '' -f "$work/ssh-host"
ssh-keygen -q -t ed25519 -N '' -f "$work/ssh-client"
awk -v host="[$git_host]:2222" '{print host, $1, $2}' "$work/ssh-host.pub" >"$work/known_hosts"
kube -n "$namespace" create configmap fixture-repository --from-file="source.bundle=$work/fixture.bundle"
kube -n "$namespace" create secret generic fixture-ssh \
    --from-file="host=$work/ssh-host" --from-file="authorized_keys=$work/ssh-client.pub"
kube -n "$namespace" apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: fixture-git
spec:
  selector:
    app: fixture-git
  ports:
    - name: ssh
      port: 2222
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fixture-git
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fixture-git
  template:
    metadata:
      labels:
        app: fixture-git
    spec:
      automountServiceAccountToken: false
      containers:
        - name: sshd
          image: alpine:3.23
          command:
            - /bin/sh
            - -ec
            - |
              apk add --no-cache git openssh-server
              adduser -D -h /home/git git
              passwd -d git
              mkdir -p /run/sshd
              mkdir -m 700 /home/git/.ssh
              install -m 600 /keys/authorized_keys /home/git/.ssh/authorized_keys
              git clone --bare /fixture/source.bundle /home/git/fixture.git
              chown -R git:git /home/git
              chmod go-w /home/git
              install -m 600 /keys/host /run/fixture-host-key
              exec /usr/sbin/sshd -D -e -f /dev/null -o Port=2222 \
                -o HostKey=/run/fixture-host-key -o AuthorizedKeysFile=.ssh/authorized_keys \
                -o AllowUsers=git -o PermitRootLogin=no -o PasswordAuthentication=no \
                -o KbdInteractiveAuthentication=no -o DisableForwarding=yes \
                -o 'ForceCommand=git upload-pack /home/git/fixture.git'
          readinessProbe:
            tcpSocket:
              port: 2222
          volumeMounts:
            - name: repository
              mountPath: /fixture
              readOnly: true
            - name: keys
              mountPath: /keys
              readOnly: true
      volumes:
        - name: repository
          configMap:
            name: fixture-repository
        - name: keys
          secret:
            secretName: fixture-ssh
YAML
kube -n "$namespace" rollout status deployment/fixture-git --timeout=180s

stage=canette-api
step 'Signing in and triggering a Git deployment through the Canette API'
email="e2e-$run_id@example.test"
password="Canette!$(openssl rand -hex 16)"
jq -n --arg email "$email" --arg password "$password" \
    '{name:"Canette E2E",email:$email,password:$password}' | post_json /api/auth/sign-up/email >/dev/null
account_created=true
jq -n --arg email "$email" --arg password "$password" \
    '{email:$email,password:$password}' | post_json /api/auth/sign-in/email >/dev/null

team_id="$(api GET /api/v1/teams | jq -er '.[0].id')"
project_id="$(jq -n --arg teamId "$team_id" --arg slug "$project_slug" \
    '{teamId:$teamId,name:"Smoke test",slug:$slug}' | post_json /api/v1/projects | jq -er .id)"
credential_id="$(jq -n --rawfile key "$work/ssh-client" --rawfile hosts "$work/known_hosts" \
    '{name:"Local fixture",provider:"generic",type:"ssh_key",value:$key,sshKnownHosts:$hosts}' |
    post_json "/api/v1/teams/$team_id/credentials" | jq -er .id)"
app_id="$(jq -n --arg slug "$app_slug" --arg gitUrl "ssh://git@$git_host:2222/home/git/fixture.git" --arg credential "$credential_id" \
    '{name:"Hello",slug:$slug,sourceType:"git",deploymentType:"web",gitUrl:$gitUrl,gitBranch:"main",gitCredentialId:$credential,port:8080}' |
    post_json "/api/v1/projects/$project_id/apps" | jq -er .id)"
deployment_id="$(printf '{}\n' | post_json "/api/v1/apps/$app_id/deployments" | jq -er .id)"

stage=deployment
step "Waiting for deployment $deployment_id"
deadline=$((SECONDS + 420))
previous=''
while (( SECONDS < deadline )); do
    api GET "/api/v1/apps/$app_id/deployments" |
        jq -ce --arg id "$deployment_id" '.items[] | select(.id == $id)' >"$work/deployment.json"
    status="$(jq -er .status "$work/deployment.json")"
    if [[ "$status" != "$previous" ]]; then
        printf '  %s\n' "$status"
        previous="$status"
    fi
    case "$status" in
        live) break ;;
        failed|stopped) die "$(jq -r '.errorMessage // .status' "$work/deployment.json")" ;;
    esac
    sleep 3
done
[[ "$previous" == live ]] || die 'Deployment did not reach live within seven minutes.'
digest="$(jq -er --arg sha "$fixture_sha" '
    select(.commitSha == $sha) | .imageDigest | select(test("^sha256:[a-f0-9]{64}$"))
' "$work/deployment.json")" || die 'The deployment did not report the fixture commit and a built image digest.'

stage=https-assertion
step 'Verifying the workload image and public HTTPS response'
app_namespace="$(kube get namespace -l "canette.dev/project-id=$project_id" -o json |
    jq -er '.items | select(length == 1) | .[0].metadata.name')"
kube -n "$app_namespace" get pods -l "canette.dev/deployment=$deployment_id" -o json |
    jq -e --arg image "$registry_host/$project_slug/$app_slug@$digest" '
        any(.items[];
            . as $pod
            | any(.spec.containers[] | select(.image == $image) | .name;
                . as $name
                | any($pod.status.containerStatuses[]?;
                    .name == $name and .ready == true and (.imageID | length > 0))))
    ' >/dev/null || die 'No ready pod is running the candidate app image from the bundled registry.'
live_url="https://$app_host"
live_url_reported() {
    [[ "$(api GET "/api/v1/apps/$app_id" | jq -r '.liveUrl // ""')" == "$live_url" ]]
}
retry 30 live_url_reported || die "Canette did not report the expected live URL $live_url."
fixture_responds() {
    local body
    body="$(https "$app_host" --fail "$live_url" 2>/dev/null)" && [[ "$body" == "$marker" ]]
}
retry 60 fixture_responds || die "HTTPS response never matched the fixture at $live_url."
printf '\nPASS %s deployed fixture %s at %s\n' "$sha" "$fixture_sha" "$live_url"
