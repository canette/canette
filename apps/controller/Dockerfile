FROM golang:1.26.2-alpine AS builder
WORKDIR /src

COPY apps/controller/go.mod apps/controller/go.sum ./apps/controller/
COPY packages/golib/go.mod packages/golib/go.sum ./packages/golib/
RUN cd apps/controller && go mod download

COPY apps/controller/ ./apps/controller/
COPY packages/golib/ ./packages/golib/
RUN CGO_ENABLED=0 GOOS=linux go build -o /controller ./apps/controller/

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /controller /controller
ENTRYPOINT ["/controller"]
