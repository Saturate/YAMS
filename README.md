# 🍠 YAMS

**Your AI Memory System** - nutritious context for your AI

Self-hosted memory layer for AI coding assistants. Captures what you work on, remembers cross-project patterns, and surfaces relevant context - across all your machines and tools.

## Quick start

```bash
# Clone and start all services
git clone https://github.com/Saturate/YAMS.git
cd YAMS
docker compose up -d
```

This starts YAMS, Qdrant, and Ollama - and auto-pulls the embedding model on first run.

Open `http://localhost:3000/setup` to create your admin account.

### Create an API key

1. Log in at `http://localhost:3000`
2. Go to **API Keys** → **Create Key**
3. Copy the key (`yams_...`) - you won't see it again

### Install the Claude Code plugin

```bash
claude plugin add /path/to/YAMS/plugins/claude-code
```

When prompted, set the `YAMS_API_KEY` environment variable to the key you created.

Memories are now captured automatically at the end of each session and available via MCP tools (`search`, `remember`, `list_projects`).

## How it works

The server is **client-agnostic**. `/ingest` is a universal write endpoint - any tool that can run a shell script or make an HTTP call can send memories. The plugin decides how it captures and retrieves, the server just stores.

## Memory scopes

| Scope     | What                   | Example                                                                              |
| --------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `session` | Single coding session  | "Migrated Stripe v2 to v3 - checkout and billing done, webhooks still need updating" |
| `project` | Per-repo knowledge     | "Legacy API returns dates as DD/MM/YYYY, not ISO 8601 - parse with dayjs.utc()"     |
| `global`  | Cross-project patterns | "Always use bun, not npm. Prefers biome over eslint+prettier"                        |

Projects are keyed by **git remote URL** - works across machines regardless of where the repo is checked out.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All variables have sensible defaults.

| Variable               | Default                  | Description                          |
| ---------------------- | ------------------------ | ------------------------------------ |
| `YAMS_PORT`            | `3000`                   | Server port                          |
| `YAMS_DB_PATH`         | `data/yams.db`           | SQLite database path                 |
| `YAMS_JWT_SECRET`      | auto-generated           | JWT signing secret                   |
| `QDRANT_URL`           | `http://localhost:6333`  | Qdrant server URL                    |
| `OLLAMA_URL`           | `http://localhost:11434` | Ollama server URL                    |
| `OLLAMA_MODEL`         | `nomic-embed-text`       | Embedding model                      |
| `EMBEDDING_DIMENSIONS` | `768`                    | Vector dimensions (must match model) |

## Deployment

Cookies are only marked `Secure` when `NODE_ENV=production`, so **localhost works out of the box** - no HTTPS needed for local use.

For remote/public deployments, create a `docker-compose.prod.yml`:

```yaml
services:
  yams:
    image: ghcr.io/saturate/yams:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data/yams:/data
    environment:
      - NODE_ENV=production
      - YAMS_DB_PATH=/data/yams.db
      - YAMS_JWT_SECRET=change-me-to-a-random-string
      - QDRANT_URL=http://qdrant:6333
      - OLLAMA_URL=http://ollama:11434
    depends_on:
      qdrant:
        condition: service_started
      ollama:
        condition: service_healthy
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - ./data/qdrant:/qdrant/storage
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ./data/ollama:/root/.ollama
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 5s
      timeout: 3s
      start_period: 5s

  ollama-pull:
    image: curlimages/curl:latest
    depends_on:
      ollama:
        condition: service_healthy
    restart: "no"
    entrypoint: >
      sh -c "curl -fSL http://ollama:11434/api/pull
      -d '{\"name\":\"nomic-embed-text\",\"stream\":false}'"

```

Put it behind a reverse proxy for HTTPS. Minimal Caddy example:

```
yams.example.com {
    reverse_proxy localhost:3000
}
```

**Backups:** The SQLite database at `YAMS_DB_PATH` is the only stateful file. Back it up regularly. Qdrant data can be rebuilt by re-ingesting.

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

## License

MIT
