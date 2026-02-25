import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database;

export function getDb(): Database {
	return db;
}

export function initDb(path?: string): Database {
	const dbPath = path ?? process.env.YAMS_DB_PATH ?? "data/yams.db";

	if (dbPath !== ":memory:") {
		mkdirSync(dirname(dbPath), { recursive: true });
	}

	db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	db.run(`
		CREATE TABLE IF NOT EXISTS config (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			label TEXT NOT NULL,
			key_hash TEXT UNIQUE NOT NULL,
			key_prefix TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 1,
			expires_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_used_at TEXT
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY,
			api_key_id TEXT NOT NULL REFERENCES api_keys(id),
			git_remote TEXT,
			scope TEXT NOT NULL DEFAULT 'session',
			summary TEXT NOT NULL,
			metadata TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_memories_git_remote ON memories(git_remote)");
	db.run("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");

	return db;
}

// --- Users ---

export function getUserCount(): number {
	const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM users").get();
	return row?.count ?? 0;
}

export function getUserByUsername(username: string) {
	return db
		.query<{ id: string; username: string; password_hash: string; created_at: string }, [string]>(
			"SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
		)
		.get(username);
}

export function createUser(username: string, passwordHash: string): string {
	const id = crypto.randomUUID();
	db.query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(
		id,
		username,
		passwordHash,
	);
	return id;
}

// --- API Keys ---

export function createApiKey(params: {
	userId: string;
	label: string;
	keyHash: string;
	keyPrefix: string;
	expiresAt: string | null;
}): string {
	const id = crypto.randomUUID();
	db.query(
		"INSERT INTO api_keys (id, user_id, label, key_hash, key_prefix, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run(id, params.userId, params.label, params.keyHash, params.keyPrefix, params.expiresAt);
	return id;
}

interface ApiKeyRow {
	id: string;
	user_id: string;
	label: string;
	key_hash: string;
	key_prefix: string;
	is_active: number;
	expires_at: string | null;
	created_at: string;
	last_used_at: string | null;
}

export function getApiKeyByHash(hash: string) {
	return db.query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE key_hash = ?").get(hash);
}

export function getApiKeyById(id: string) {
	return db.query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(id);
}

export function listApiKeys(userId?: string) {
	if (userId) {
		return db
			.query<Omit<ApiKeyRow, "key_hash">, [string]>(
				"SELECT id, user_id, label, key_prefix, is_active, expires_at, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
			)
			.all(userId);
	}
	return db
		.query<Omit<ApiKeyRow, "key_hash">, []>(
			"SELECT id, user_id, label, key_prefix, is_active, expires_at, created_at, last_used_at FROM api_keys ORDER BY created_at DESC",
		)
		.all();
}

export function revokeApiKey(id: string): boolean {
	const result = db.query("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(id);
	return result.changes > 0;
}

export function updateKeyLastUsed(id: string) {
	db.query("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

// --- Memories ---

export interface MemoryRow {
	id: string;
	api_key_id: string;
	git_remote: string | null;
	scope: string;
	summary: string;
	metadata: string | null;
	created_at: string;
}

export function createMemory(params: {
	id: string;
	apiKeyId: string;
	gitRemote?: string | null;
	scope: string;
	summary: string;
	metadata?: string | null;
}): string {
	db.query(
		"INSERT INTO memories (id, api_key_id, git_remote, scope, summary, metadata) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		params.id,
		params.apiKeyId,
		params.gitRemote ?? null,
		params.scope,
		params.summary,
		params.metadata ?? null,
	);
	return params.id;
}

export function getMemory(id: string): MemoryRow | undefined {
	return db.query<MemoryRow, [string]>("SELECT * FROM memories WHERE id = ?").get(id) ?? undefined;
}

export function listMemories(opts?: {
	gitRemote?: string;
	scope?: string;
	limit?: number;
	offset?: number;
}): MemoryRow[] {
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (opts?.gitRemote) {
		conditions.push("git_remote = ?");
		params.push(opts.gitRemote);
	}
	if (opts?.scope) {
		conditions.push("scope = ?");
		params.push(opts.scope);
	}

	let sql = "SELECT * FROM memories";
	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}
	sql += " ORDER BY created_at DESC";

	const limit = opts?.limit ?? 100;
	const offset = opts?.offset ?? 0;
	sql += " LIMIT ? OFFSET ?";
	params.push(limit, offset);

	return db.query<MemoryRow, (string | number)[]>(sql).all(...params);
}

export function deleteMemory(id: string): boolean {
	const result = db.query("DELETE FROM memories WHERE id = ?").run(id);
	return result.changes > 0;
}

export function listDistinctGitRemotes(): string[] {
	const rows = db
		.query<{ git_remote: string }, []>(
			"SELECT DISTINCT git_remote FROM memories WHERE git_remote IS NOT NULL ORDER BY git_remote",
		)
		.all();
	return rows.map((r) => r.git_remote);
}

export function listDistinctScopes(): string[] {
	const rows = db
		.query<{ scope: string }, []>("SELECT DISTINCT scope FROM memories ORDER BY scope")
		.all();
	return rows.map((r) => r.scope);
}

export function countMemories(opts?: {
	gitRemote?: string;
	scope?: string;
}): number {
	const conditions: string[] = [];
	const params: string[] = [];

	if (opts?.gitRemote) {
		conditions.push("git_remote = ?");
		params.push(opts.gitRemote);
	}
	if (opts?.scope) {
		conditions.push("scope = ?");
		params.push(opts.scope);
	}

	let sql = "SELECT COUNT(*) as count FROM memories";
	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	const row = db.query<{ count: number }, string[]>(sql).get(...params);
	return row?.count ?? 0;
}

// --- JWT Secret ---

export function getOrCreateJwtSecret(): string {
	const envSecret = process.env.YAMS_JWT_SECRET;
	if (envSecret) return envSecret;

	const row = db
		.query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?")
		.get("jwt_secret");

	if (row) return row.value;

	const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	db.query("INSERT INTO config (key, value) VALUES (?, ?)").run("jwt_secret", secret);
	return secret;
}
