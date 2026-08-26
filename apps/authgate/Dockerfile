FROM golang:1.26.2-alpine AS builder
WORKDIR /src

COPY apps/authgate/go.mod apps/authgate/go.sum ./apps/authgate/
COPY packages/golib/go.mod packages/golib/go.sum ./packages/golib/
RUN cd apps/authgate && go mod download

COPY apps/authgate/ ./apps/authgate/
COPY packages/golib/ ./packages/golib/
RUN cd apps/authgate && CGO_ENABLED=0 GOOS=linux go build -o /authgate .

FROM scratch
COPY --from=builder /authgate /authgate
ENTRYPOINT ["/authgate"]
