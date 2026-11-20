# Contributing to canette

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | 1.3.11+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Go](https://go.dev) | 1.23+ | [go.dev/dl](https://go.dev/dl) |
| [golangci-lint](https://golangci-lint.run) | latest | `brew install golangci-lint` or `curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \| sh -s -- -b /usr/local/bin` |

## Install dependencies

```bash
bun install
```

## Linting

All linters must pass before a PR can be merged. CI runs them automatically on every pull request.

### TypeScript

```bash
bun run lint:ui
bun run lint:api
bun run lint:docs
```

### Go

```bash
bun run lint:builder
bun run lint:controller
bun run lint:logstreamer
```

golangci-lint uses the config at [`.golangci.yml`](./.golangci.yml) in the repo root.

## Tests

### TypeScript

```bash
bun run test:api
```

### Go

```bash
bun run test:builder
bun run test:controller
bun run test:logstreamer
```

### Local end-to-end smoke test

On an Apple Silicon Mac, use the [local smoke test](./scripts/e2e/README.md) for a quick pre-merge check of Helm changes, Git builds, or HTTPS routing. It installs the checked-out commit in a dedicated cluster and deploys a small Git-backed app. Choose Lima with K3s or the experimental Apple Container backend.

## Type checking

```bash
bun run typecheck
```

## Building

```bash
bun run build:ui
bun run build:api
bun run build:docs
```

## Project structure

See [`AGENTS.md`](./AGENTS.md) for a full description of the monorepo layout, architecture decisions, and component responsibilities.
