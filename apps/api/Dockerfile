# ---- Base image with Bun ----
FROM oven/bun:1-slim AS base
WORKDIR /app

# ---- Install dependencies (with caching) ----
FROM base AS build

# Copy root files
COPY bun.lock package.json ./

# Copy workspace package manifests
COPY apps/api/package.json apps/api/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/types/package.json packages/types/package.json

# Install dependencies
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY apps/api/scripts ./apps/api/scripts
COPY apps/api/migrations ./apps/api/migrations
COPY apps/api/src ./apps/api/src

# RUN bun run test:api
RUN bun run build:api

# ---- Production image ----
FROM debian:13.4-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only necessary files
COPY --from=build /app/apps/api/api-server ./api-server

EXPOSE 3000

CMD [ "./api-server" ]
