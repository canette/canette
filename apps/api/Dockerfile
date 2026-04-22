# ---- Base image with Bun ----
FROM oven/bun:1-slim AS base
WORKDIR /app

# ---- Install dependencies (with caching) ----
FROM base AS deps

# Copy root files
COPY bun.lock package.json ./

# Copy workspace package manifests
COPY apps/api/package.json apps/api/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/types/package.json packages/types/package.json

# Install dependencies
RUN bun install --frozen-lockfile --production

# ---- Production image ----
FROM oven/bun:1-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only necessary files
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api ./apps/api
COPY apps/api/src ./apps/api/src
COPY apps/api/scripts ./apps/api/scripts
COPY apps/api/migrations ./apps/api/migrations
COPY bun.lock package.json ./

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["bun", "run", "start"]