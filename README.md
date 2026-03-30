# HUSK

- **H**elpful **U**niversal **S**torage for **K**nowledge
- **H**andy **U**tility for **S**aving **K**nowledge
- ...you get the idea

Self-hosted memory layer for AI coding assistants. Captures what you work on, remembers cross-project patterns, and surfaces relevant context - across all your machines and tools.

<p align="center">
  <img src="demo.gif" alt="HUSK demo" width="640">
</p>

## Quick start

```bash
# Clone and start all services
git clone https://github.com/Saturate/HUSK.git
cd HUSK
docker compose up -d
```

This starts HUSK, Qdrant, and Ollama - and auto-pulls the embedding model on first run.

Open `http://localhost:3000/setup` to create your admin account.

### Create an API key

1. Log in at `http://localhost:3000`
2. Go to **API Keys** → **Create Key**
3. Copy the key (`husk_...`) - you won't see it again

### Connect Claude Code

**Option A: MCP config** (recommended)

Add a `.mcp.json` to your project root (or `~/.claude/.mcp.json` for global access):

```json
{
  "mcpServers": {
    "husk": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer husk_your-api-key-here"
      }
    }
  }
}
```

Restart Claude Code and the MCP tools (`search`, `remember`, `list_projects`, `session_context`, `get_session_detail`) are available immediately.

**Option B: Plugin** (includes session-end hooks and skills)

```bash
claude plugin add /path/to/HUSK/plugins/claude-code
```

Set `HUSK_URL` and `HUSK_KEY` environment variables to your server URL and API key.

## How it works

The server is **client-agnostic**. `/ingest` is a universal write endpoint - any tool that can run a shell script or make an HTTP call can send memories. The plugin decides how it captures and retrieves, the server just stores.

## Memory scopes

| Scope       | What                        | Example                                                                              |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `session`   | Single coding session       | "Migrated Stripe v2 to v3 - checkout and billing done, webhooks still need updating" |
| `project`   | Per-repo knowledge          | "Legacy API returns dates as DD/MM/YYYY, not ISO 8601 - parse with dayjs.utc()"     |
| `workspace` | Shared across related repos | "All client-a repos use Postgres 15 with RLS policies"                               |
| `global`    | Cross-project patterns      | "Always use bun, not npm. Prefers biome over eslint+prettier"                        |

Projects are keyed by **git remote URL** - works across machines regardless of where the repo is checked out. Workspaces group related projects so memories can be shared across repos in the same organization or client.

## Configuration

Configure via environment variables, a `husk.toml` file, or both. Env vars always take priority over TOML. See `.env.example` and `server/husk.toml.example` for all options.

| Variable             | Default                  | Description                          |
| -------------------- | ------------------------ | ------------------------------------ |
| `HUSK_PORT`          | `3000`                   | Server port                          |
| `HUSK_DB_PATH`       | `data/husk.db`           | SQLite database path                 |
| `HUSK_JWT_SECRET`    | auto-generated           | JWT signing secret                   |
| `HUSK_STORAGE`       | `qdrant`                 | Storage backend (`qdrant`, `sqlite-vec`) |
| `HUSK_STORAGE_URL`   | `http://localhost:6333`  | Qdrant server URL                    |
| `HUSK_EMBEDDINGS`    | `ollama`                 | Embedding backend (`ollama`, `transformers`, `voyage`, `openai`, `llamacpp`) |
| `HUSK_EMBED_URL`     | per-provider default     | Embedding provider endpoint          |
| `HUSK_EMBED_MODEL`   | per-provider default     | Embedding model name                 |
| `HUSK_EMBED_API_KEY` | —                        | API key (required for voyage, openai) |

## Deployment

Cookies are only marked `Secure` when `NODE_ENV=production`, so **localhost works out of the box** - no HTTPS needed for local use.

For remote/public deployments, create a `docker-compose.prod.yml`:

```yaml
services:
  husk:
    image: ghcr.io/saturate/husk:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data/husk:/data
    environment:
      - NODE_ENV=production
      - HUSK_DB_PATH=/data/husk.db
      - HUSK_JWT_SECRET=change-me-to-a-random-string
      - HUSK_STORAGE_URL=http://qdrant:6333
      - HUSK_EMBED_URL=http://ollama:11434
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
husk.example.com {
    reverse_proxy localhost:3000
}
```

**Backups:** The SQLite database at `HUSK_DB_PATH` is the only stateful file. Back it up regularly. Qdrant data can be rebuilt by re-ingesting.

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
