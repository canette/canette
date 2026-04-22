# canette image-build image

Pre-baked Ubuntu 24.04 image with `railpack` and `buildctl` installed at build time.
Used as the base image for canette build jobs, replacing the runtime download approach.

## Build and push

```bash
IMAGE_REPO=my-registry ./scripts/build-images.sh --push
```

Override versions via `--build-arg` or set them as ARG defaults in the Dockerfile (`RAILPACK_VERSION`, `BUILDKIT_VERSION`).

## Pushing to an in-cluster registry via port-forward

If you are port-forwarding the in-cluster registry to `localhost:5000`:

```bash
kubectl port-forward -n canette-system svc/registry 5000:5000
```

Because the registry is HTTP-only and `docker buildx` runs BuildKit inside its own
container (`localhost` inside that container is not your Mac), use `host.docker.internal:5000`
instead of `localhost:5000`.

Write a config file and create a buildx builder with it (passing config via stdin is
unreliable on Mac and the builder will still attempt HTTPS):

```bash
cat > /tmp/buildkitd.toml <<EOF
[registry."host.docker.internal:5000"]
  http = true
  insecure = true
EOF

docker buildx rm insecure-builder 2>/dev/null || true

docker buildx create \
  --name insecure-builder \
  --driver docker-container \
  --driver-opt network=host \
  --config /tmp/buildkitd.toml \
  --bootstrap

docker buildx use insecure-builder
```

Then build and push:

```bash
IMAGE_REPO=host.docker.internal:5000 PLATFORMS=linux/amd64 ./scripts/build-images.sh --push
```

Switch back to the default builder and remove the insecure builder when done:

```bash
docker context use default
docker buildx rm insecure-builder
```

## Using the image

Set `BUILDER_IMAGE` when running the canette builder:

```bash
BUILDER_IMAGE=localhost:5000/canette-builder-image-build:latest ./bin/builder
```

In cluster, use the pull registry address instead of `localhost:5000`. This is the same address as `PULL_REPO` for the controller:

```
BUILDER_IMAGE=registry.192-168-64-2.traefik.me:32500/canette-builder-image-build:latest
```
