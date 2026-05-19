FROM golang:1.26.2-alpine AS builder
WORKDIR /src

COPY apps/builder/go.mod apps/builder/go.sum ./apps/builder/
COPY packages/golib/go.mod packages/golib/go.sum ./packages/golib/
RUN cd apps/builder && go mod download

COPY apps/builder/ ./apps/builder/
COPY packages/golib/ ./packages/golib/
RUN cd apps/builder && CGO_ENABLED=0 GOOS=linux go build -o /builder .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /builder /builder
ENTRYPOINT ["/builder"]
