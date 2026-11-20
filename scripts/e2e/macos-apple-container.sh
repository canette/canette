#!/usr/bin/env bash
# Run the local Git-to-HTTPS smoke test in an Apple Container cluster.
set -euo pipefail
umask 077

source "$(dirname "${BASH_SOURCE[0]}")/smoke.sh"

usage() {
    cat <<'USAGE'
Usage: scripts/e2e/macos-apple-container.sh [--setup | --check | --keep | --cleanup]

Requires Apple Silicon, macOS 26 or later, and Apple Container 1.7.1 or later.
Run the test from a Canette checkout. It builds committed HEAD for linux/arm64.
  --setup    Create or reuse the dedicated Apple Container cluster.
  --check    Check the checkout and running test cluster.
  --keep     Keep the test cluster and print its dashboard login.
  --cleanup  Delete the dedicated cluster and its recorded branch image tags.

A test run creates the cluster as needed and deletes it on exit by default.
Apple Container's builder cache is shared across runs.
Set APPLE_E2E_DNS to a reachable IPv4 resolver if the default VM DNS fails.
Set APPLE_E2E_BUILDER_CACHE_MB to trim unused shared build cache after each image.
USAGE
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*" >&2; }

mode=run
keep=false
case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    --setup) mode=setup ;;
    --check) mode=check ;;
    --keep) keep=true ;;
    --cleanup) mode=cleanup ;;
    '') ;;
    *) usage >&2; exit 2 ;;
esac
(( $# <= 1 )) || die 'Expected at most one option.'
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] ||
    die 'Run this script on an Apple Silicon Mac using a native shell.'
for tool in container kubectl jq; do
    command -v "$tool" >/dev/null || die "Missing command: $tool"
done
cluster_help="$(container cluster create --help 2>&1)"
[[ "$cluster_help" == *--shared-image-store* ]] ||
    die 'Install Apple Container 1.7.1 or later with the cluster plugin.'

cluster=canette-apple-e2e
state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/canette-e2e/apple-container"
kubeconfig="$state_dir/kubeconfig"
# Apple also writes kubeconfig during cluster creation and deletion.
export KUBECONFIG="$kubeconfig"

gateway_namespace=kube-system
gateway_name=canette-apple-e2e
domain=apps.canette-apple-e2e.test
ui_host="ui.$domain"
registry_host="registry.$domain"
tls_secret=canette-apple-e2e-tls
infra_label=canette.dev/local-e2e
image_repo=canette-apple-e2e.invalid/canette
release=canette
cache_mb="${APPLE_E2E_BUILDER_CACHE_MB:-}"
if [[ -n "$cache_mb" ]]; then
    [[ "$cache_mb" =~ ^[1-9][0-9]*$ ]] || die 'APPLE_E2E_BUILDER_CACHE_MB must be a positive integer.'
fi
dns="${APPLE_E2E_DNS:-}"
build_dns=()
if [[ -n "$dns" ]]; then
    [[ "$dns" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
        die 'APPLE_E2E_DNS must be an IPv4 nameserver address.'
    build_dns=(--dns "$dns")
fi

kube() { kubectl --kubeconfig "$kubeconfig" --context "$cluster" "$@"; }
node() { container exec "$cluster" "$@"; }
cluster_info() {
    container cluster list --format json |
        jq -c --arg name "$cluster" '.[] | select(.id == $name)'
}

ensure_cluster() {
    local info
    info="$(cluster_info)" || die 'Start Apple Container with container system start.'
    if [[ -n "$info" ]]; then
        [[ -f "$state_dir/owned" ]] || die "A cluster named $cluster already exists outside this harness."
        jq -e '.status.state == "running" and .configuration.sharedImageStore == true' <<<"$info" >/dev/null ||
            die "The test cluster is unavailable. Run --cleanup and then --setup."
    else
        touch "$state_dir/owned"
        step "Creating $cluster with Apple Container"
        container cluster create --name "$cluster" --cpus 4 --memory 6g --shared-image-store
    fi
    if [[ ! -r "$kubeconfig" ]]; then
        container cluster write-config --name "$cluster" --kubeconfig "$kubeconfig"
    fi
}

read_nodes() {
    nodes="$(kube --request-timeout=5s get nodes -o json 2>/dev/null)"
}

check_cluster() {
    local info nodes
    [[ -f "$state_dir/owned" && -r "$kubeconfig" ]] || die 'Run --setup to create the test cluster.'
    info="$(cluster_info)"
    node_ip="$(jq -er '
        select(.status.state == "running" and .configuration.sharedImageStore == true)
        | .status.nodes | select(length == 1) | .[0].addresses[0]
    ' <<<"$info")" || die 'Expected a running single-node Apple Container cluster with a shared image store.'
    [[ "$node_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Apple Container did not report a node IPv4 address.'
    retry 45 read_nodes || die 'The Apple Container API forwarding did not become reachable.'
    jq -e --arg name "$cluster" --arg ip "$node_ip" '
        .items | select(length == 1) | .[0]
        | .metadata.name == $name and .status.nodeInfo.architecture == "arm64"
        and any(.status.addresses[]; .type == "InternalIP" and .address == $ip)
        and any(.status.conditions[]; .type == "Ready" and .status == "True")
    ' <<<"$nodes" >/dev/null || die 'The kubeconfig did not identify the ready Apple Container node.'
}

remove_cluster() {
    local info ref
    if [[ ! -f "$state_dir/owned" ]]; then
        printf 'No Apple Container test cluster is recorded.\n'
        return
    fi
    info="$(cluster_info)" || return
    if [[ -n "$info" ]]; then
        container cluster delete --name "$cluster" || return
    fi
    if [[ -f "$state_dir/images" ]]; then
        while IFS= read -r ref; do
            [[ "$ref" == "$image_repo/"* && "${ref##*:}" =~ ^git-[a-f0-9]{12}-[a-f0-9]{8}$ ]] || return 1
            container image delete --force "$ref" || return
        done < "$state_dir/images"
    fi
    rm -f "$state_dir/owned" "$state_dir/images" "$kubeconfig"
}

if [[ "$mode" != check ]]; then
    mkdir -p "$state_dir"
    mkdir "$state_dir/lock" 2>/dev/null || die "Another run is active. A stale lock can be removed at $state_dir/lock."
    trap 'rmdir "$state_dir/lock"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
fi

case "$mode" in
    cleanup) remove_cluster; exit ;;
    setup)
        ensure_cluster
        check_cluster
        printf 'Apple Container cluster ready. Kubeconfig: %s\n' "$kubeconfig"
        exit
        ;;
esac

for tool in git helm mkcert curl ssh-keygen openssl tar; do
    command -v "$tool" >/dev/null || die "Missing command: $tool"
done
repo="$(git rev-parse --show-toplevel)" || die 'Run from a Canette checkout.'
cd "$repo"
sha="$(git rev-parse --verify HEAD)"
git diff --quiet HEAD -- || die 'Commit or stash tracked changes first.'
git cat-file -e "${sha}:charts/canette/Chart.yaml" || die 'Canette chart missing from HEAD.'
for image in "${images[@]}"; do
    git cat-file -e "$sha:${image#*:}" || die "Missing Dockerfile for ${image%%:*}."
done
if [[ "$mode" == check ]]; then
    check_cluster
    printf 'Preflight passed for %s at %s\n' "$cluster" "$node_ip"
    exit
fi

ensure_cluster
check_cluster
runs="$(kube get namespace -l "$infra_label=run" -o name)"
[[ -z "$runs" ]] || die 'A kept release is still active. Run --cleanup before starting another test.'

init_smoke_run
finish() {
    local status=$? logs
    trap - EXIT
    set +e
    if (( status != 0 )); then
        printf 'Test failed during %s (exit %s).\n' "$stage" "$status" >&2
        logs="$(mktemp -d "${TMPDIR:-/tmp}/canette-apple-logs.XXXXXXXX")"
        for log in platform-build.log helm.log deployment.json; do
            [[ ! -f "$work/$log" ]] || cp "$work/$log" "$logs/"
        done
        kube --request-timeout=10s get pods,pvc,events -A -o wide >"$logs/cluster.log" 2>&1
        if "$release_created"; then
            kube --request-timeout=10s -n "$namespace" logs deployment/canette-api --tail=100 >"$logs/api.log" 2>&1
        fi
        if [[ -n "$deployment_id" ]]; then
            api GET "/api/v1/deployments/$deployment_id/logs" >"$logs/build.json" 2>/dev/null
        fi
        printf 'Failure diagnostics: %s\n' "$logs" >&2
    fi
    if "$keep"; then
        printf 'Kept %s. Kubeconfig: %s\n' "$cluster" "$kubeconfig"
        if "$account_created"; then
            printf '\nCanette dashboard: https://%s/login/email\nUsername (email): %s\nPassword: %s\n' \
                "$ui_host" "$email" "$password"
        fi
    else
        remove_cluster || { printf 'Cleanup failed. Retry with --cleanup.\n' >&2; status=1; }
    fi
    rm -rf -- "$work"
    rmdir "$state_dir/lock"
    exit "$status"
}
trap finish EXIT

ca_dir="$state_dir/ca"
mkdir -p "$ca_dir"
CAROOT="$ca_dir" mkcert -cert-file "$work/tls.crt" -key-file "$work/tls.key" "*.$domain" >"$work/mkcert.log" 2>&1 ||
    die 'Could not issue the Gateway certificate.'
ca="$ca_dir/rootCA.pem"
cookie="$work/session.cookies"
touch "$cookie"

stage=registry-trust
step 'Installing the test registry CA in the Apple Container node'
container exec -i "$cluster" sh -ec '
    registry="$1"
    ip="$2"
    cert="/usr/local/share/ca-certificates/canette-apple-e2e.crt"
    tmp="$(mktemp)"
    trap "rm -f \"$tmp\"" EXIT
    cat >"$tmp"
    if ! cmp -s "$tmp" "$cert"; then
        install -m 644 "$tmp" "$cert"
        update-ca-certificates
        systemctl restart containerd
    fi
    sed "/# canette-apple-e2e$/d" /etc/hosts >"$tmp"
    printf "%s %s # canette-apple-e2e\n" "$ip" "$registry" >>"$tmp"
    cat "$tmp" >/etc/hosts
' sh "$registry_host" "$node_ip" <"$ca"
kube wait --for=condition=Ready "node/$cluster" --timeout=120s

stage=dns
if [[ -n "$dns" ]]; then
    step 'Configuring the test node DNS resolver'
    node sh -ec 'printf "nameserver %s\n" "$1" >/etc/resolv.conf' sh "$dns"
    kube -n kube-system rollout restart deployment/coredns
    kube -n kube-system rollout status deployment/coredns --timeout=120s
fi
retry 20 node getent ahostsv4 registry-1.docker.io >/dev/null ||
    die 'The node could not resolve Docker Hub. Check or set APPLE_E2E_DNS to a reachable IPv4 resolver.'

guest_registry_reachable() {
    [[ "$(node curl --silent --show-error --noproxy '*' --max-time 8 \
        -o /dev/null -w '%{http_code}' "https://$registry_host/v2/" 2>/dev/null)" == 401 ]]
}

stage=storage
step 'Installing local-path storage'
kube apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml
kube annotate storageclass local-path storageclass.kubernetes.io/is-default-class=true --overwrite
kube -n local-path-storage rollout status deployment/local-path-provisioner --timeout=180s

stage=gateway
step 'Installing Gateway API and Traefik with a node HTTPS port'
kube apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/standard-install.yaml
kube -n "$gateway_namespace" create secret tls "$tls_secret" \
    --cert="$work/tls.crt" --key="$work/tls.key" --dry-run=client -o yaml | kube apply -f -
helm --kubeconfig "$kubeconfig" upgrade --install canette-apple-gateway traefik \
    --repo https://traefik.github.io/charts --version 41.6.1 \
    -n "$gateway_namespace" --wait --timeout 4m -f - <<YAML
service:
  type: ClusterIP
ports:
  websecure:
    hostPort: 443
providers:
  kubernetesGateway:
    enabled: true
    statusAddress:
      ip: "$node_ip"
gateway:
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
kube -n "$gateway_namespace" wait --for=condition=Programmed "gateway/$gateway_name" --timeout=120s

stage=platform-images
step 'Building the branch images in Apple Container’s shared image store'
mkdir -p "$work/source"
# Keep the run directory private and preserve readable modes in the build context.
(
    umask 022
    git -c tar.umask=0022 archive "$sha" | tar -xf - -C "$work/source"
)
chart_dir="$work/source/charts/canette"
for image in "${images[@]}"; do
    ref="$image_repo/${image%%:*}:$tag"
    printf '%s\n' "$ref" >>"$state_dir/images"
    container build ${build_dns[@]+"${build_dns[@]}"} --platform linux/arm64 --progress plain --file "$work/source/${image#*:}" \
        --tag "$ref" "$work/source" 2>&1 | tee -a "$work/platform-build.log"
    if [[ -n "$cache_mb" ]]; then
        step "Trimming unused Apple builder cache toward ${cache_mb} MB"
        container exec buildkit buildctl prune --keep-storage "$cache_mb" >>"$work/platform-build.log" 2>&1 ||
            die 'Could not trim the Apple builder cache.'
        container exec buildkit fstrim / >>"$work/platform-build.log" 2>&1 ||
            printf 'The Apple builder could not release discarded disk blocks.\n' >&2
    fi
done

run_canette_smoke
