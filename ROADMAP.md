# Roadmap

A project is never done, so here goes the road map. Might be implemented in this order, or maybe not.

- Better Memory Capture
- ~~Memory deletion via MCP tool (not just UI)~~
- Sensitive data filtering before storage (<private> tags, configurable regex patterns, for api keys ect.)
- Encryption of data at rest
- Retention policy (memory TTL)
- More embedding examples, should be able to be whatever configured
- Doc's site using fumadocs
- ~~Token-budgeted retrieval — MCP tool takes a max_tokens param. YAMS returns the most relevant memories that fit within budget. The caller doesn't have to guess how many results to ask for.~~
- Semantic deduplication — Before storing a memory, check similarity against existing ones. If it's >90% similar, merge or skip. Every other memory tool just keeps appending. This would keep the DB clean without manual curation.
- Memory types / structured schemas — Not everything is the same. A "decision" (we chose Postgres over MySQL because...) is different from a "pattern" (this codebase uses repository pattern) is different from a "gotcha" (this API returns 200 on errors). Typed memories enable smarter retrieval — when Claude starts a new feature surface decisions and patterns; when debugging, surface gotchas.
- Contradiction detection — "Last week you said use JWT for auth in project X, now you're saying session cookies." Surface conflicts instead of silently storing both. This is the kind of thing that makes AI memory actually useful vs just a blob of context.
- ~~Observation granularity~~ — ~~Individual observation fetch by ID for precise context retrieval.~~ Timeline browsing to see chronological context around a specific observation still TODO.
- Zero-config install — Embedded mode where YAMS runs as an MCP server directly inside the client process, no separate server or Qdrant needed. SQLite for everything (FTS5 keyword search as vector search fallback). Single-user setups should be `npx yams` and done — no Docker, no external services.
