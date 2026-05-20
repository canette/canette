FROM golang:1.26.2-alpine AS builder

WORKDIR /src
COPY apps/builder/go.mod apps/builder/go.sum ./apps/builder/
COPY packages/golib/go.mod packages/golib/go.sum ./packages/golib/
RUN cd apps/builder && go mod download

COPY apps/builder/ ./apps/builder/
COPY packages/golib/ ./packages/golib/
RUN cd apps/builder && CGO_ENABLED=0 GOOS=linux go build -o /git-init ./cmd/git-init/

FROM alpine/git:2.47.2

RUN addgroup -S -g 10001 canette && adduser -S -u 10001 -G canette canette

COPY --from=builder /git-init /usr/local/bin/git-init

USER canette
ENTRYPOINT ["/usr/local/bin/git-init"]
