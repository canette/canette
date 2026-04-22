FROM golang:1.25-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /git-init ./cmd/git-init/

FROM alpine/git:2.47.2

RUN addgroup -S -g 10001 canette && adduser -S -u 10001 -G canette canette

COPY --from=builder /git-init /usr/local/bin/git-init

USER canette
ENTRYPOINT ["/usr/local/bin/git-init"]
