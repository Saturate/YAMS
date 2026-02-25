# YAMS

**Your AI Memory System** — nutritious context for your AI

Self-hosted memory layer for AI coding assistants. Captures what you work on, remembers cross-project patterns, and surfaces relevant context — across all your machines and tools.

---

## Quick start

```bash
# Clone and start all services
git clone https://github.com/Saturate/YAMS.git
cd YAMS
docker compose up -d
```

This starts YAMS, Qdrant, and Ollama — and auto-pulls the embedding model on first run.

Open `http://localhost:3000/setup` to create your admin account.

### Create an API key

1. Log in at `http://localhost:3000`
2. Go to **API Keys** → **Create Key**
3. Copy the key (`yams_...`) — you won't see it again

### Install the Claude Code plugin

```bash
claude plugin add /path/to/YAMS/plugins/claude-code
```

When prompted, set the `YAMS_API_KEY` environment variable to the key you created.

Memories are now captured automatically at the end of each session and available via MCP tools (`search`, `remember`, `list_projects`).

---

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│                        YAMS Server                           │
│                                                              │
│   POST /ingest  ← hooks (shell scripts, any client)         │
│   POST /mcp     ← MCP tools (Claude Code, Cursor, etc.)     │
│   GET  /api/*   ← management REST API                       │
│   GET  /        ← React management UI                       │
│                                                              │
│   SQLite  →  users, machine keys, session metadata          │
│   Qdrant  →  vector embeddings                              │
└──────────────────────────────────────────────────────────────┘
          ↑                          ↑
  Claude Code plugin           Cursor plugin (future)
  hooks  → POST /ingest        extension → POST /ingest
  MCP    → /mcp                REST → /api/search
```

The server is **client-agnostic**. `/ingest` is a universal write endpoint — any tool that can run a shell script or make an HTTP call can send memories. The plugin decides how it captures and retrieves, the server just stores.

---

## Memory scopes

| Scope | What | Example |
|---|---|---|
| `session` | Single session | "Fixed auth bug by resetting cookie domain" |
| `project` | Per-repo knowledge | "This repo uses Zod, never Joi" |
| `global` | Cross-project patterns | "Prefer TanStack Query for server state" |

Projects are keyed by **git remote URL** — works across machines regardless of where the repo is checked out.

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All variables have sensible defaults.

| Variable | Default | Description |
|---|---|---|
| `YAMS_PORT` | `3000` | Server port |
| `YAMS_DB_PATH` | `data/yams.db` | SQLite database path |
| `YAMS_JWT_SECRET` | auto-generated | JWT signing secret |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimensions (must match model) |

---

## Deployment

Cookies are only marked `Secure` when `NODE_ENV=production`, so **localhost works out of the box** — no HTTPS needed for local use.

For remote/public deployments, set `NODE_ENV=production` and run behind a reverse proxy (Nginx, Caddy, Traefik) for HTTPS.

**Minimal Caddy example:**

```
yams.example.com {
    reverse_proxy localhost:3000
}
```

**Backups:** The SQLite database at `YAMS_DB_PATH` is the only stateful file. Back it up regularly. Qdrant data can be rebuilt by re-ingesting.

---

## Development

```bash
# Start Qdrant + Ollama (server runs locally)
docker compose -f docker-compose.dev.yml up -d

# Install deps
bun install
cd server/ui && bun install && cd ../..

# Run server with hot reload
cd server && bun run dev

# Run tests
cd server && bun test

# Lint + format
cd server && bun run check
```

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| HTTP framework | Hono |
| Database | `bun:sqlite` (auth/keys) + Qdrant (vectors) |
| Embeddings | Ollama (`nomic-embed-text`) |
| MCP | `@modelcontextprotocol/sdk` |
| Logging | `@logtape/logtape` (JSON Lines in prod, ANSI in dev) |
| Auth | argon2 + JWT (jose) |
| Linting | Biome |
| UI | Vite + React + Tailwind + Radix |
| Deployment | Docker Compose |

---

## Project structure

```
YAMS/
  server/
    src/
      index.ts          ← entry, startup logging
      app.ts            ← Hono app, route registration, middleware
      mcp.ts            ← MCP server + tools
      ingest.ts         ← POST /ingest handler
      auth.ts           ← login, JWT, API key CRUD
      db.ts             ← SQLite schema + queries
      qdrant.ts         ← Qdrant client wrapper
      embeddings.ts     ← embedding provider (Ollama)
      setup.ts          ← first-run wizard
      logger.ts         ← LogTape configuration
      rate-limit.ts     ← sliding window rate limiter
    ui/                 ← Vite + React (built → served by Hono)
  plugins/
    claude-code/        ← Claude Code plugin (hooks + MCP + skills)
  docker-compose.yml    ← production (YAMS + Qdrant + Ollama)
  docker-compose.dev.yml ← dev (Qdrant + Ollama only)
  Dockerfile
```

## License

MIT
