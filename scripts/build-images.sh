#!/usr/bin/env bash
# build-images.sh — build and optionally push all canette component images.
#
# Usage:
#   IMAGE_REPO=ghcr.io/myorg ./scripts/build-images.sh                   # build + load locally
#   IMAGE_REPO=ghcr.io/myorg ./scripts/build-images.sh --push            # build + push
#   IMAGE_REPO=ghcr.io/myorg ./scripts/build-images.sh --push --latest   # build + push + :latest
#   IMAGE_REPO=ghcr.io/myorg TAG=abc1234 ./scripts/build-images.sh --push
#
# Environment variables:
#   IMAGE_REPO  required  Registry prefix, e.g. ghcr.io/myorg or my-registry:5000
#   TAG         optional  Image tag (default: edge)
#   PLATFORMS   optional  Comma-separated platform list (default: linux/amd64,linux/arm64)
#                         Note: --load (no --push) only supports a single platform;
#                         use PLATFORMS=linux/amd64 for local builds

set -euo pipefail

PUSH=false
ADD_LATEST=false
for arg in "$@"; do
  case $arg in
    --push) PUSH=true ;;
    --latest) ADD_LATEST=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "${IMAGE_REPO:-}" ]; then
  echo "Error: IMAGE_REPO is required" >&2
  echo "  Example: IMAGE_REPO=ghcr.io/myorg ./scripts/build-images.sh" >&2
  exit 1
fi

if [ "${ADD_LATEST}" = "true" ] && [ "${PUSH}" = "false" ]; then
  echo "Error: --latest requires --push" >&2
  exit 1
fi

TAG="${TAG:-edge}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
REPO="${IMAGE_REPO%/}"  # strip trailing slash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

API_IMAGE="${REPO}/canette-api"
UI_IMAGE="${REPO}/canette-ui"
BUILDER_IMAGE="${REPO}/canette-builder"
CONTROLLER_IMAGE="${REPO}/canette-controller"
GIT_INIT_IMAGE="${REPO}/canette-builder-git-init"
IMAGE_BUILD_IMAGE="${REPO}/canette-builder-image-build"
LOGSTREAMER_IMAGE="${REPO}/canette-logstreamer"

# Output flag: --push sends directly to the registry; --load puts into the local daemon
OUTPUT_FLAG="--load"
if [ "${PUSH}" = "true" ]; then
  OUTPUT_FLAG="--push"
fi

# Per-image tag arrays — extended with :latest when --latest is set
t_api=(-t "${API_IMAGE}:${TAG}")
t_ui=(-t "${UI_IMAGE}:${TAG}")
t_builder=(-t "${BUILDER_IMAGE}:${TAG}")
t_controller=(-t "${CONTROLLER_IMAGE}:${TAG}")
t_git_init=(-t "${GIT_INIT_IMAGE}:${TAG}")
t_image_build=(-t "${IMAGE_BUILD_IMAGE}:${TAG}")
t_logstreamer=(-t "${LOGSTREAMER_IMAGE}:${TAG}")

if [ "${ADD_LATEST}" = "true" ]; then
  t_api+=(-t "${API_IMAGE}:latest")
  t_ui+=(-t "${UI_IMAGE}:latest")
  t_builder+=(-t "${BUILDER_IMAGE}:latest")
  t_controller+=(-t "${CONTROLLER_IMAGE}:latest")
  t_git_init+=(-t "${GIT_INIT_IMAGE}:latest")
  t_image_build+=(-t "${IMAGE_BUILD_IMAGE}:latest")
  t_logstreamer+=(-t "${LOGSTREAMER_IMAGE}:latest")
fi

echo "==> Building canette images (7 total)"
echo "    Repo:      ${REPO}"
echo "    Tag:       ${TAG}"
echo "    Platforms: ${PLATFORMS}"
echo "    Push:      ${PUSH}"
echo "    Latest:    ${ADD_LATEST}"
echo ""

# ── api ──────────────────────────────────────────────────────────────────────
echo "==> [1/7] api: ${API_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_api[@]}" \
  -f "${REPO_ROOT}/apps/api/Dockerfile" \
  "${REPO_ROOT}"

# ── ui ───────────────────────────────────────────────────────────────────────
echo "==> [2/7] ui: ${UI_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_ui[@]}" \
  -f "${REPO_ROOT}/apps/ui/Dockerfile" \
  "${REPO_ROOT}"

# ── builder ──────────────────────────────────────────────────────────────────
echo "==> [3/7] builder: ${BUILDER_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_builder[@]}" \
  -f "${REPO_ROOT}/apps/builder/Dockerfile" \
  "${REPO_ROOT}/apps/builder"

# ── git-init ─────────────────────────────────────────────────────────────────
echo "==> [4/7] git-init: ${GIT_INIT_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_git_init[@]}" \
  -f "${REPO_ROOT}/apps/builder/images/git-init/Dockerfile" \
  "${REPO_ROOT}/apps/builder"

# ── controller ───────────────────────────────────────────────────────────────
echo "==> [5/7] controller: ${CONTROLLER_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_controller[@]}" \
  -f "${REPO_ROOT}/apps/controller/Dockerfile" \
  "${REPO_ROOT}/apps/controller"

# ── image-build ──────────────────────────────────────────────────────────────
echo "==> [6/7] image-build: ${IMAGE_BUILD_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_image_build[@]}" \
  -f "${REPO_ROOT}/apps/builder/images/image-build/Dockerfile" \
  "${REPO_ROOT}/apps/builder"

# ── logstreamer ──────────────────────────────────────────────────────────────
echo "==> [7/7] logstreamer: ${LOGSTREAMER_IMAGE}:${TAG}"
docker buildx build \
  --platform "${PLATFORMS}" \
  "${OUTPUT_FLAG}" \
  "${t_logstreamer[@]}" \
  -f "${REPO_ROOT}/apps/logstreamer/Dockerfile" \
  "${REPO_ROOT}/apps/logstreamer"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
echo "==> Done"
echo "    ${API_IMAGE}:${TAG}"
echo "    ${UI_IMAGE}:${TAG}"
echo "    ${BUILDER_IMAGE}:${TAG}"
echo "    ${GIT_INIT_IMAGE}:${TAG}"
echo "    ${CONTROLLER_IMAGE}:${TAG}"
echo "    ${IMAGE_BUILD_IMAGE}:${TAG}"
echo "    ${LOGSTREAMER_IMAGE}:${TAG}"
