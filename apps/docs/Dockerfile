FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Copy root files
COPY bun.lock package.json ./

# Copy workspace package manifests
COPY apps/api/package.json apps/api/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/types/package.json packages/types/package.json

# Install dependencies (skip postinstall — source not present yet)
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY apps/docs apps/docs
COPY packages/types packages/types

# Run fumadocs-mdx codegen now that source.config.ts is present, then build
RUN bun run --cwd apps/docs postinstall && bun run --cwd apps/docs build

FROM caddy:alpine
COPY --from=builder /app/apps/docs/out /usr/share/caddy
COPY apps/docs/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
