#!/usr/bin/env bash
# Run a Canette Git-to-HTTPS smoke test on a Lima K3s VM on Apple Silicon.
set -euo pipefail
umask 077

usage() {
    cat <<'USAGE'
Usage: scripts/e2e/macos-lima.sh [--setup | --check | --cleanup | [--lifecycle] [--keep]]

Requires macOS on Apple Silicon. Run tests from a Canette checkout to build
committed HEAD for linux/arm64.
  --setup    Create or start the dedicated Lima K3s VM. Runs from any directory.
  --check    Check the checkout and running cluster without changing either.
  --keep     Keep the test release and print its dashboard login.
  --lifecycle
             After the smoke test, run the lifecycle scenarios in tests/lifecycle
             (Go). Set LIFECYCLE_RUN to a go test -run pattern to run some of them.
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
lifecycle=false
for arg in "$@"; do
    case "$arg" in
        --help|-h) usage; exit 0 ;;
        --setup) setup_only=true ;;
        --check) check_only=true ;;
        --keep) keep=true ;;
        --lifecycle) lifecycle=true ;;
        --cleanup) cleanup_only=true ;;
        *) usage >&2; exit 2 ;;
    esac
done
(( $# <= 1 )) || { (( $# == 2 )) && "$keep" && "$lifecycle"; } ||
    die 'Expected at most one option, or --lifecycle with --keep.'

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

vm() { limactl shell --workdir / "$instance" "$@"; }
find_node_ip() { vm ip -4 -o addr show dev lima0 | awk 'NR == 1 { split($4, a, "/"); print a[1] }'; }
node_ip_hint='No IPv4 address on lima0. Start Lima with --network=vzNAT.'

source "$(dirname "${BASH_SOURCE[0]}")/k3s.sh"
