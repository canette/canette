# Shared steps of the K3s smoke-test backends (macos-lima.sh, linux-k3s.sh),
# sourced after the backend has parsed its options and found its cluster.
# The backend provides die, step, the options (check_only, keep, cleanup_only,
# lifecycle), instance (names the lock and CA directories), kubeconfig, and:
#   vm              runs a command on the K3s node
#   find_node_ip    prints the node IP that serves the Gateway on port 443
#   node_ip_hint    the error shown when find_node_ip prints no IPv4 address
# The node must be a single ARM64 K3s node that the script may reconfigure.

source "$(dirname "${BASH_SOURCE[0]}")/smoke.sh"

kube() { kubectl --kubeconfig "$kubeconfig" "$@"; }

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
        [[ "$ref" == "$registry_host/smoke-$run_id/"* || "$ref" == "$registry_host/smoke-$run_id-"* ]]; then
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

    # The smoke project and the lifecycle projects (smoke-<id>-*), including
    # the old namespaces of renamed ones.
    local app_namespaces
    app_namespaces="$(kube --request-timeout=10s get namespace -l app.kubernetes.io/managed-by=canette -o json |
        jq -r --arg slug "smoke-$target_id" '.items[]
            | select(.metadata.labels["canette.dev/project"] as $p | $p == $slug or ($p | startswith($slug + "-")))
            | .metadata.name')" || return
    if [[ -n "$app_namespaces" ]]; then
        # shellcheck disable=SC2086 # one namespace name per line
        kube delete namespace $app_namespaces --ignore-not-found --timeout=90s || return
    fi
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
[[ "$node_uid" == "$guest_uid" ]] || die "KUBECONFIG points to a different cluster than the K3s node of $instance."

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
! "$lifecycle" || command -v go >/dev/null || die 'Missing command: go (needed for --lifecycle)'

repo="$(git rev-parse --show-toplevel)" || die 'Run from a cloned Canette repository.'
cd "$repo"
sha="$(git rev-parse --verify HEAD)"
git diff --quiet HEAD -- || die 'Commit or stash tracked changes first. The test builds committed HEAD.'
git cat-file -e HEAD:charts/canette/Chart.yaml || die 'Canette chart missing from HEAD.'
git cat-file -e HEAD:scripts/build-images.sh || die 'Canette image build script missing from HEAD.'

for image in "${images[@]}"; do
    git cat-file -e "HEAD:${image#*:}" || die "Missing Dockerfile for ${image%%:*}."
done

step "Checking the checkout (${sha:0:12}) and cluster readiness"
jq -e 'any(.items[0].status.conditions[]; .type == "Ready" and .status == "True")' <<<"$nodes" >/dev/null ||
    die 'The K3s node is not ready.'
node_ip="$(find_node_ip)"
[[ "$node_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$node_ip_hint"
kube --request-timeout=10s -n "$gateway_namespace" get helmchart traefik >/dev/null
kube --request-timeout=10s get storageclass local-path >/dev/null
vm python3 -c 'import yaml' || die 'Install python3-yaml on the K3s node.'

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

init_smoke_run
build_namespace="$namespace-build"
guest_work=''
images_started=false

diagnostics() {
    local logs
    logs="$(mktemp -d "${TMPDIR:-/tmp}/canette-e2e-logs.XXXXXXXX")" || return
    for file in platform-build.log helm.log deployment.json lifecycle.log; do
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
ca_file.chmod(0o644)
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
chart_dir="$work/chart/charts/canette"
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

guest_registry_reachable() {
    [[ "$(vm curl --silent --show-error --noproxy '*' --max-time 8 \
        --cacert /etc/rancher/k3s/canette-e2e-registry-ca.pem \
        -o /dev/null -w '%{http_code}' "https://$registry_host/v2/" 2>/dev/null)" == 401 ]]
}

run_canette_smoke
if "$lifecycle"; then
    run_lifecycle_tests
fi
