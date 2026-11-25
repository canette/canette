#!/usr/bin/env bash
# Run a Canette Git-to-HTTPS smoke test on K3s installed on this ARM64 Linux
# host, such as a GitHub Actions runner.
set -euo pipefail
umask 077

usage() {
    cat <<'USAGE'
Usage: scripts/e2e/linux-k3s.sh [--setup | --check | --cleanup | [--lifecycle] [--keep]]

Requires ARM64 Linux with systemd and sudo, on a disposable host: the test
changes /etc/hosts, the K3s registry configuration, a sysctl and systemd
units, and restarts K3s. Set CANETTE_E2E_DISPOSABLE_HOST=1 to confirm (CI
runners are detected through CI=true). Run tests from a Canette checkout to
build committed HEAD for linux/arm64.
  --setup    Install K3s (K3S_VERSION) and the test's apt packages.
  --check    Check the checkout and running cluster without changing either.
  --keep     Keep the test release and print its dashboard login.
  --lifecycle
             After the smoke test, run the lifecycle scenarios in tests/lifecycle
             (Go). Set LIFECYCLE_RUN to a go test -run pattern to run some of them.
  --cleanup  Delete retained test releases, fixture namespaces, PVCs, and images.

Environment:
  KUBECONFIG      Its single kubeconfig file (default: /etc/rancher/k3s/k3s.yaml)
  K3S_VERSION     K3s release for --setup (default: the one macos-lima.sh is tested on)
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

[[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] ||
    die 'Run this script on ARM64 Linux.'
[[ "${CI:-}" == true || "${CANETTE_E2E_DISPOSABLE_HOST:-}" == 1 ]] ||
    die 'This test reconfigures the host. Run it on a disposable host and set CANETTE_E2E_DISPOSABLE_HOST=1.'

instance=linux-k3s
k3s_kubeconfig=/etc/rancher/k3s/k3s.yaml

if "$setup_only"; then
    version="${K3S_VERSION:-v1.37.2+k3s1}"
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] || die "Invalid K3S_VERSION: $version"
    step 'Installing the test packages'
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq mkcert python3-yaml
    if command -v k3s >/dev/null; then
        step "Reusing installed $(k3s --version | head -1)"
    else
        step "Installing K3s $version"
        # The installer from the release tag verifies the binary's checksum.
        curl --fail --location --silent --show-error --retry 2 \
            "https://raw.githubusercontent.com/k3s-io/k3s/${version/+/%2B}/install.sh" |
            sudo INSTALL_K3S_VERSION="$version" sh -s - --write-kubeconfig-mode 644
    fi
    timeout 180 bash -c 'until sudo k3s kubectl get nodes 2>/dev/null | grep -q " Ready "; do sleep 3; done' ||
        die 'The K3s node did not become ready.'
    # Traefik and local-path are installed by K3s's deploy controller.
    timeout 180 bash -c 'until sudo k3s kubectl -n kube-system get helmchart traefik >/dev/null 2>&1; do sleep 3; done' ||
        die 'K3s did not create the Traefik HelmChart.'
    printf 'Kubeconfig: %s\n' "$k3s_kubeconfig"
    exit 0
fi

kubeconfig="${KUBECONFIG:-$k3s_kubeconfig}"
[[ -r "$kubeconfig" ]] || die "Kubeconfig is unreadable: $kubeconfig. Run --setup to install K3s."
for command in kubectl helm jq; do
    command -v "$command" >/dev/null || die "Missing command: $command"
done

vm() { "$@"; }
find_node_ip() {
    kubectl --kubeconfig "$kubeconfig" --request-timeout=10s get nodes \
        -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}'
}
node_ip_hint='The K3s node reports no IPv4 InternalIP.'

source "$(dirname "${BASH_SOURCE[0]}")/k3s.sh"
