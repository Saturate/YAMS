# Roadmap

## Done

- ~~Memory deletion via MCP tool (not just UI)~~
- ~~Retention policy (memory TTL with per-scope defaults)~~
- ~~Token-budgeted retrieval (max_tokens param, returns as much as fits)~~
- ~~Semantic deduplication (configurable similarity threshold)~~
- ~~Observation granularity (individual observation fetch by ID)~~
- ~~Documentation site (fumadocs)~~

## Retrieval approaches

HUSK currently uses vector/semantic search. These are the planned approaches, each adding a new retrieval dimension without replacing existing ones.

### Knowledge graph layer

Add relationship tracking on top of existing vector search. Memories would have typed edges: "caused by", "contradicts", "supersedes", "related to". This enables queries that vector search can't answer well:

- "Why did we switch from JWT to session cookies?" (causal chain)
- "What decisions have we made about auth in this project?" (entity traversal)
- "Does this new memory conflict with anything we already know?" (contradiction detection)

Implementation: graph-in-SQLite (adjacency tables) rather than Neo4j. Keep the stack simple.

### Full-text search (FTS5)

SQLite FTS5 alongside vector search. Useful when you know the exact term ("that function called parseISO") rather than the concept. Also enables the zero-config embedded mode since FTS5 doesn't need Qdrant.

### Hybrid retrieval

Combine vector + graph + FTS results using reciprocal rank fusion. Different query types benefit from different approaches. Let the system pick the best combination automatically.

## Features

### Claude Memory API bridge

Act as the storage backend for Claude's native [Memory API](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/memory-tool) (`memory_20250818`). When Claude emits `create`/`view`/`str_replace` calls, HUSK handles them with vector indexing, semantic dedup, scoping, and TTL on top.

This would give HUSK native integration with any app using the Claude API, not just MCP clients.

### Memory types / structured schemas

Not everything is the same. A "decision" (we chose Postgres over MySQL because...) is different from a "pattern" (this codebase uses repository pattern) is different from a "gotcha" (this API returns 200 on errors).

Typed memories enable smarter retrieval: when starting a new feature, surface decisions and patterns. When debugging, surface gotchas.

### Contradiction detection

"Last week you said use JWT for auth in project X, now you're saying session cookies." Surface conflicts instead of silently storing both. This is the kind of thing that makes AI memory actually useful vs just a blob of context.

Pairs well with the knowledge graph layer (contradictions as typed edges).

### Sensitive data filtering

Filter out secrets before storage. `<private>` tags for explicit exclusion, configurable regex patterns for API keys, tokens, passwords. Never store what shouldn't be stored.

### CLAUDE.md / MEMORY.md export

Generate a CLAUDE.md or MEMORY.md file from HUSK memories for tools that don't support MCP. Bridges the gap between HUSK's semantic search and the file-based approach that works everywhere.

### Timeline browsing

Chronological view of observations around a specific point in time. See what happened before and after, not just the single observation.

### Zero-config embedded mode

Single-user mode where HUSK runs as an MCP server directly inside the client process. SQLite for everything (FTS5 as vector search fallback). No Docker, no Qdrant, no Ollama.

```
npx husk
```

### Pluggable embedding backends

More embedding options beyond Ollama. OpenAI, Anthropic, Cohere, local ONNX models. Should be configurable without code changes.
