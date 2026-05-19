FROM golang:1.26.2-alpine AS builder
WORKDIR /src

COPY apps/logstreamer/go.mod apps/logstreamer/go.sum ./apps/logstreamer/
COPY packages/golib/go.mod packages/golib/go.sum ./packages/golib/
RUN cd apps/logstreamer && go mod download

COPY apps/logstreamer/ ./apps/logstreamer/
COPY packages/golib/ ./packages/golib/
RUN cd apps/logstreamer && CGO_ENABLED=0 GOOS=linux go build -o /logstreamer .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /logstreamer /logstreamer
ENTRYPOINT ["/logstreamer"]
