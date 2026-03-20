# ── Stage 1: Install + Build ──────────────────────────────────
FROM oven/bun:1 AS build

WORKDIR /app

# Workspace root deps (cache layer) - include all workspace package.json
# files so bun can resolve the lockfile correctly
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY cli/package.json cli/package.json
COPY plugins/claude-code/package.json plugins/claude-code/package.json
COPY plugins/opencode/package.json plugins/opencode/package.json
COPY website/package.json website/package.json
RUN bun install --frozen-lockfile

# UI deps (separate lockfile)
COPY server/ui/package.json server/ui/bun.lock server/ui/
RUN cd server/ui && bun install --frozen-lockfile

# Copy source and build UI
COPY server/ server/

RUN cd server && bun run build:ui

# ── Stage 2: Production-only deps ────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY cli/package.json cli/package.json
COPY plugins/claude-code/package.json plugins/claude-code/package.json
COPY plugins/opencode/package.json plugins/opencode/package.json
COPY website/package.json website/package.json
RUN bun install --frozen-lockfile --production

# ── Stage 3: Production (Alpine) ─────────────────────────────
FROM oven/bun:1-alpine

RUN addgroup -S husk && adduser -S husk -G husk && apk add --no-cache su-exec

WORKDIR /app/server

# Workspace root (Bun resolves hoisted deps from here)
COPY --from=deps /app/package.json /app/package.json
COPY --from=deps /app/node_modules /app/node_modules

# Server deps (not all packages are hoisted in Bun workspaces)
COPY --from=deps /app/server/node_modules ./node_modules
COPY --from=deps /app/server/package.json ./package.json

# Server source
COPY --from=build /app/server/src ./src
COPY --from=build /app/server/bunfig.toml ./bunfig.toml

# Built UI assets
COPY --from=build /app/server/ui/dist ./ui/dist

# SQLite data volume
RUN mkdir -p /data && chown husk:husk /data

COPY docker-entrypoint.sh /usr/local/bin/

ENV HUSK_DB_PATH=/data/husk.db
ENV HUSK_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); if (!r.ok) process.exit(1)" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
