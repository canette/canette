FROM golang:1.25-alpine AS canette-bins

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /canette-config ./cmd/canette-config/
RUN CGO_ENABLED=0 GOOS=linux go build -o /canette-build ./cmd/canette-build/

FROM ubuntu:24.04

ARG RAILPACK_VERSION=0.23.0
ARG BUILDKIT_VERSION=0.21.0
ARG TARGETARCH

RUN apt-get update -qq \
 && apt-get install -yqq --no-install-recommends ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) RP_ARCH="x86_64" ;; \
      arm64) RP_ARCH="arm64"  ;; \
    esac \
 && curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${RP_ARCH}-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin railpack

RUN case "${TARGETARCH}" in \
      amd64) BK_ARCH="amd64" ;; \
      arm64) BK_ARCH="arm64" ;; \
    esac \
 && curl -fsSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${BK_ARCH}.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin bin/buildctl

RUN groupadd -g 10001 canette && useradd -u 10001 -g 10001 -m -s /bin/sh canette

COPY --from=canette-bins /canette-config /usr/local/bin/canette-config
COPY --from=canette-bins /canette-build /usr/local/bin/canette-build

USER canette
