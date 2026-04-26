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

See [`CLAUDE.md`](./CLAUDE.md) for a full description of the monorepo layout, architecture decisions, and component responsibilities.
