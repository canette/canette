FROM oven/bun:1-slim AS base

WORKDIR /app

COPY bun.lock package.json ./
COPY packages/types/package.json packages/types/
COPY apps/api/package.json apps/api/
COPY apps/ui/package.json apps/ui/
COPY apps/docs/package.json apps/docs/

FROM base AS builder

ENV NEXT_TELEMETRY_DISABLED=1
RUN bun install --frozen-lockfile

COPY packages/types packages/types
COPY apps/ui apps/ui

RUN bun run --cwd apps/ui build

FROM base AS runner

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN bun install --frozen-lockfile --production

COPY packages/types/src packages/types/src
COPY packages/types/package.json packages/types/
COPY apps/ui/package.json apps/ui/
COPY apps/ui/next.config.ts apps/ui/
COPY --from=builder /app/apps/ui/.next apps/ui/.next
COPY --from=builder /app/apps/ui/public apps/ui/public

EXPOSE 3000

CMD ["bun", "./node_modules/.bun/node_modules/next/dist/bin/next", "start", "apps/ui"]
