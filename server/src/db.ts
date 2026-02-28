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
			password_hash TEXT,
			role TEXT NOT NULL DEFAULT 'user',
			oauth_provider TEXT,
			oauth_id TEXT,
			avatar_url TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	// Migration: add role column if missing (existing DBs)
	const userCols = db
		.query<{ name: string; notnull: number }, []>("PRAGMA table_info(users)")
		.all();
	const colNames = new Set(userCols.map((c) => c.name));
	if (!colNames.has("role")) {
		db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
		// All existing users predate roles, promote them to admin
		db.run("UPDATE users SET role = 'admin'");
	}
	if (!colNames.has("oauth_provider")) {
		db.run("ALTER TABLE users ADD COLUMN oauth_provider TEXT");
		db.run("ALTER TABLE users ADD COLUMN oauth_id TEXT");
		db.run("ALTER TABLE users ADD COLUMN avatar_url TEXT");
	}
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id) WHERE oauth_provider IS NOT NULL",
	);
	// Migration: make password_hash nullable (required for OAuth users)
	// SQLite can't ALTER COLUMN, so we recreate the table.
	const pwCol = userCols.find((c) => c.name === "password_hash");
	if (pwCol?.notnull) {
		db.run("PRAGMA foreign_keys = OFF");
		db.run("BEGIN");
		db.run("DROP TABLE IF EXISTS users_new");
		db.run(`
			CREATE TABLE users_new (
				id TEXT PRIMARY KEY,
				username TEXT UNIQUE NOT NULL,
				password_hash TEXT,
				role TEXT NOT NULL DEFAULT 'user',
				oauth_provider TEXT,
				oauth_id TEXT,
				avatar_url TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		db.run(
			"INSERT INTO users_new SELECT id, username, password_hash, role, oauth_provider, oauth_id, avatar_url, created_at FROM users",
		);
		db.run("DROP TABLE users");
		db.run("ALTER TABLE users_new RENAME TO users");
		db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id) WHERE oauth_provider IS NOT NULL",
		);
		db.run("COMMIT");
		db.run("PRAGMA foreign_keys = ON");
		db.run("PRAGMA foreign_key_check");
	}

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

	db.run(`
		CREATE TABLE IF NOT EXISTS invites (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			token TEXT UNIQUE NOT NULL,
			role TEXT NOT NULL DEFAULT 'user',
			created_by TEXT NOT NULL REFERENCES users(id),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			expires_at TEXT NOT NULL,
			used_at TEXT
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token)");
	db.run("CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email)");

	db.run(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			claude_session_id TEXT NOT NULL,
			api_key_id TEXT NOT NULL REFERENCES api_keys(id),
			project TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			summary TEXT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at TEXT
		)
	`);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_claude_apikey ON sessions(claude_session_id, api_key_id)",
	);
	db.run("CREATE INDEX IF NOT EXISTS idx_sessions_api_key_id ON sessions(api_key_id)");
	db.run("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)");

	db.run(`
		CREATE TABLE IF NOT EXISTS observations (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			event TEXT NOT NULL,
			tool_name TEXT,
			content TEXT NOT NULL,
			compressed INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_observations_session_id ON observations(session_id)");
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_observations_compressed ON observations(compressed) WHERE compressed = 0",
	);

	// Migration: add enrichment columns to observations
	const obsCols = db.query<{ name: string }, []>("PRAGMA table_info(observations)").all();
	const obsColNames = new Set(obsCols.map((c) => c.name));
	if (!obsColNames.has("prompt")) {
		db.run("ALTER TABLE observations ADD COLUMN prompt TEXT");
		db.run("ALTER TABLE observations ADD COLUMN tool_input_summary TEXT");
		db.run("ALTER TABLE observations ADD COLUMN files_modified TEXT");
	}

	return db;
}

// --- Users ---

export function getUserCount(): number {
	const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM users").get();
	return row?.count ?? 0;
}

export interface UserRow {
	id: string;
	username: string;
	password_hash: string | null;
	role: string;
	oauth_provider: string | null;
	oauth_id: string | null;
	avatar_url: string | null;
	created_at: string;
}

export function getUserByUsername(username: string) {
	return db.query<UserRow, [string]>("SELECT * FROM users WHERE username = ?").get(username);
}

export function getUserById(id: string) {
	return db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByOAuth(provider: string, oauthId: string) {
	return db
		.query<UserRow, [string, string]>(
			"SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?",
		)
		.get(provider, oauthId);
}

export function listUsers() {
	return db.query<UserRow, []>("SELECT * FROM users ORDER BY created_at ASC").all();
}

export function createUser(
	username: string,
	passwordHash: string | null,
	opts?: { role?: string; oauthProvider?: string; oauthId?: string; avatarUrl?: string },
): string {
	const id = crypto.randomUUID();
	db.query(
		"INSERT INTO users (id, username, password_hash, role, oauth_provider, oauth_id, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		id,
		username,
		passwordHash,
		opts?.role ?? "user",
		opts?.oauthProvider ?? null,
		opts?.oauthId ?? null,
		opts?.avatarUrl ?? null,
	);
	return id;
}

export function deleteUser(id: string): boolean {
	const txn = db.transaction(() => {
		// Delete observations belonging to sessions owned by this user's API keys
		db.query(
			"DELETE FROM observations WHERE session_id IN (SELECT id FROM sessions WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id = ?))",
		).run(id);
		// Delete sessions owned by this user's API keys
		db.query(
			"DELETE FROM sessions WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id = ?)",
		).run(id);
		// Delete memories owned by this user's API keys
		db.query(
			"DELETE FROM memories WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id = ?)",
		).run(id);
		// Delete the user's API keys
		db.query("DELETE FROM api_keys WHERE user_id = ?").run(id);
		// Delete invites created by this user
		db.query("DELETE FROM invites WHERE created_by = ?").run(id);
		// Delete the user
		const result = db.query("DELETE FROM users WHERE id = ?").run(id);
		return result.changes > 0;
	});
	return txn();
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

export function getMemoryForUser(id: string, userId: string): MemoryRow | undefined {
	return (
		db
			.query<MemoryRow, [string, string]>(
				"SELECT m.* FROM memories m JOIN api_keys k ON m.api_key_id = k.id WHERE m.id = ? AND k.user_id = ?",
			)
			.get(id, userId) ?? undefined
	);
}

export function listMemories(opts?: {
	gitRemote?: string;
	scope?: string;
	limit?: number;
	offset?: number;
	userId?: string;
}): MemoryRow[] {
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (opts?.gitRemote) {
		conditions.push("m.git_remote = ?");
		params.push(opts.gitRemote);
	}
	if (opts?.scope) {
		conditions.push("m.scope = ?");
		params.push(opts.scope);
	}
	if (opts?.userId) {
		conditions.push("ak.user_id = ?");
		params.push(opts.userId);
	}

	const needsJoin = opts?.userId != null;
	let sql = needsJoin
		? "SELECT m.* FROM memories m JOIN api_keys ak ON m.api_key_id = ak.id"
		: "SELECT * FROM memories m";

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}
	sql += " ORDER BY m.created_at DESC";

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

export function listDistinctGitRemotes(userId?: string): string[] {
	if (userId) {
		const rows = db
			.query<{ git_remote: string }, [string]>(
				"SELECT DISTINCT m.git_remote FROM memories m JOIN api_keys ak ON m.api_key_id = ak.id WHERE m.git_remote IS NOT NULL AND ak.user_id = ? ORDER BY m.git_remote",
			)
			.all(userId);
		return rows.map((r) => r.git_remote);
	}
	const rows = db
		.query<{ git_remote: string }, []>(
			"SELECT DISTINCT git_remote FROM memories WHERE git_remote IS NOT NULL ORDER BY git_remote",
		)
		.all();
	return rows.map((r) => r.git_remote);
}

export function listDistinctScopes(userId?: string): string[] {
	if (userId) {
		const rows = db
			.query<{ scope: string }, [string]>(
				"SELECT DISTINCT m.scope FROM memories m JOIN api_keys ak ON m.api_key_id = ak.id WHERE ak.user_id = ? ORDER BY m.scope",
			)
			.all(userId);
		return rows.map((r) => r.scope);
	}
	const rows = db
		.query<{ scope: string }, []>("SELECT DISTINCT scope FROM memories ORDER BY scope")
		.all();
	return rows.map((r) => r.scope);
}

export function countMemories(opts?: {
	gitRemote?: string;
	scope?: string;
	userId?: string;
}): number {
	const conditions: string[] = [];
	const params: string[] = [];

	if (opts?.gitRemote) {
		conditions.push("m.git_remote = ?");
		params.push(opts.gitRemote);
	}
	if (opts?.scope) {
		conditions.push("m.scope = ?");
		params.push(opts.scope);
	}
	if (opts?.userId) {
		conditions.push("ak.user_id = ?");
		params.push(opts.userId);
	}

	const needsJoin = opts?.userId != null;
	let sql = needsJoin
		? "SELECT COUNT(*) as count FROM memories m JOIN api_keys ak ON m.api_key_id = ak.id"
		: "SELECT COUNT(*) as count FROM memories m";

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	const row = db.query<{ count: number }, string[]>(sql).get(...params);
	return row?.count ?? 0;
}

// --- Invites ---

export interface InviteRow {
	id: string;
	email: string;
	token: string;
	role: string;
	created_by: string;
	created_at: string;
	expires_at: string;
	used_at: string | null;
}

export function createInvite(params: {
	email: string;
	role: string;
	createdBy: string;
	expiresAt: string;
}): { id: string; token: string } {
	const id = crypto.randomUUID();
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
	db.query(
		"INSERT INTO invites (id, email, token, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run(id, params.email, token, params.role, params.createdBy, params.expiresAt);
	return { id, token };
}

export function getInviteByToken(token: string) {
	return db.query<InviteRow, [string]>("SELECT * FROM invites WHERE token = ?").get(token);
}

export function listInvites() {
	return db.query<InviteRow, []>("SELECT * FROM invites ORDER BY created_at DESC").all();
}

export function deleteInvite(id: string): boolean {
	const result = db.query("DELETE FROM invites WHERE id = ?").run(id);
	return result.changes > 0;
}

export function markInviteUsed(id: string) {
	db.query("UPDATE invites SET used_at = datetime('now') WHERE id = ?").run(id);
}

// --- Config ---

export function getConfig(key: string): string | undefined {
	const row = db
		.query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?")
		.get(key);
	return row?.value;
}

export function setConfig(key: string, value: string): void {
	db.query("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

export function deleteConfig(key: string): boolean {
	const result = db.query("DELETE FROM config WHERE key = ?").run(key);
	return result.changes > 0;
}

export function getConfigWithEnv(key: string, envVar: string): string | undefined {
	return process.env[envVar] ?? getConfig(key);
}

// --- Sessions ---

export interface SessionRow {
	id: string;
	claude_session_id: string;
	api_key_id: string;
	project: string | null;
	status: string;
	summary: string | null;
	started_at: string;
	ended_at: string | null;
}

export function findSession(claudeSessionId: string, apiKeyId: string): SessionRow | undefined {
	return (
		db
			.query<SessionRow, [string, string]>(
				"SELECT * FROM sessions WHERE claude_session_id = ? AND api_key_id = ?",
			)
			.get(claudeSessionId, apiKeyId) ?? undefined
	);
}

export function createSession(params: {
	claudeSessionId: string;
	apiKeyId: string;
	project?: string | null;
}): string {
	const id = crypto.randomUUID();
	db.query(
		"INSERT INTO sessions (id, claude_session_id, api_key_id, project) VALUES (?, ?, ?, ?)",
	).run(id, params.claudeSessionId, params.apiKeyId, params.project ?? null);
	return id;
}

export function findOrCreateSession(params: {
	claudeSessionId: string;
	apiKeyId: string;
	project?: string | null;
}): SessionRow {
	const existing = findSession(params.claudeSessionId, params.apiKeyId);
	if (existing) return existing;

	const id = createSession(params);
	return (
		findSession(params.claudeSessionId, params.apiKeyId) ?? {
			id,
			claude_session_id: params.claudeSessionId,
			api_key_id: params.apiKeyId,
			project: params.project ?? null,
			status: "active",
			summary: null,
			started_at: new Date().toISOString(),
			ended_at: null,
		}
	);
}

export function endSession(id: string): boolean {
	const result = db
		.query("UPDATE sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?")
		.run(id);
	return result.changes > 0;
}

export function updateSessionSummary(id: string, summary: string): void {
	db.query("UPDATE sessions SET summary = ? WHERE id = ?").run(summary, id);
}

export function getSession(id: string): SessionRow | undefined {
	return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? undefined;
}

export function getSessionForUser(id: string, userId: string): SessionRow | undefined {
	return (
		db
			.query<SessionRow, [string, string]>(
				"SELECT s.* FROM sessions s JOIN api_keys ak ON s.api_key_id = ak.id WHERE s.id = ? AND ak.user_id = ?",
			)
			.get(id, userId) ?? undefined
	);
}

export function listSessions(opts?: {
	userId?: string;
	project?: string;
	status?: string;
	limit?: number;
	offset?: number;
}): SessionRow[] {
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (opts?.userId) {
		conditions.push("ak.user_id = ?");
		params.push(opts.userId);
	}
	if (opts?.project) {
		conditions.push("s.project = ?");
		params.push(opts.project);
	}
	if (opts?.status) {
		conditions.push("s.status = ?");
		params.push(opts.status);
	}

	const needsJoin = opts?.userId != null;
	let sql = needsJoin
		? "SELECT s.* FROM sessions s JOIN api_keys ak ON s.api_key_id = ak.id"
		: "SELECT * FROM sessions s";

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}
	sql += " ORDER BY s.started_at DESC";

	const limit = opts?.limit ?? 50;
	const offset = opts?.offset ?? 0;
	sql += " LIMIT ? OFFSET ?";
	params.push(limit, offset);

	return db.query<SessionRow, (string | number)[]>(sql).all(...params);
}

export function countSessions(opts?: { userId?: string; status?: string }): number {
	const conditions: string[] = [];
	const params: string[] = [];

	if (opts?.userId) {
		conditions.push("ak.user_id = ?");
		params.push(opts.userId);
	}
	if (opts?.status) {
		conditions.push("s.status = ?");
		params.push(opts.status);
	}

	const needsJoin = opts?.userId != null;
	let sql = needsJoin
		? "SELECT COUNT(*) as count FROM sessions s JOIN api_keys ak ON s.api_key_id = ak.id"
		: "SELECT COUNT(*) as count FROM sessions s";

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	const row = db.query<{ count: number }, string[]>(sql).get(...params);
	return row?.count ?? 0;
}

export function deleteSession(id: string): boolean {
	const txn = db.transaction(() => {
		db.query("DELETE FROM observations WHERE session_id = ?").run(id);
		const result = db.query("DELETE FROM sessions WHERE id = ?").run(id);
		return result.changes > 0;
	});
	return txn();
}

// --- Observations ---

export interface ObservationRow {
	id: string;
	session_id: string;
	event: string;
	tool_name: string | null;
	content: string;
	prompt: string | null;
	tool_input_summary: string | null;
	files_modified: string | null;
	compressed: number;
	created_at: string;
}

export function createObservation(params: {
	sessionId: string;
	event: string;
	toolName?: string | null;
	content: string;
	prompt?: string | null;
	toolInputSummary?: string | null;
	filesModified?: string | null;
}): string {
	const id = crypto.randomUUID();
	const truncated =
		params.content.length > 50_000 ? params.content.slice(0, 50_000) : params.content;
	db.query(
		`INSERT INTO observations (id, session_id, event, tool_name, content, prompt, tool_input_summary, files_modified)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		params.sessionId,
		params.event,
		params.toolName ?? null,
		truncated,
		params.prompt ?? null,
		params.toolInputSummary ?? null,
		params.filesModified ?? null,
	);
	return id;
}

export function listObservations(sessionId: string): ObservationRow[] {
	return db
		.query<ObservationRow, [string]>(
			"SELECT * FROM observations WHERE session_id = ? ORDER BY created_at ASC",
		)
		.all(sessionId);
}

export function countObservations(sessionId: string): number {
	const row = db
		.query<{ count: number }, [string]>(
			"SELECT COUNT(*) as count FROM observations WHERE session_id = ?",
		)
		.get(sessionId);
	return row?.count ?? 0;
}

export function getUncompressedSessions(): SessionRow[] {
	return db
		.query<SessionRow, []>(
			`SELECT DISTINCT s.* FROM sessions s
			 JOIN observations o ON o.session_id = s.id
			 WHERE s.status = 'ended' AND o.compressed = 0
			 ORDER BY s.ended_at ASC`,
		)
		.all();
}

export function getUncompressedObservations(sessionId: string): ObservationRow[] {
	return db
		.query<ObservationRow, [string]>(
			"SELECT * FROM observations WHERE session_id = ? AND compressed = 0 ORDER BY created_at ASC",
		)
		.all(sessionId);
}

export function countUncompressedObservations(sessionId: string): number {
	const row = db
		.query<{ count: number }, [string]>(
			"SELECT COUNT(*) as count FROM observations WHERE session_id = ? AND compressed = 0",
		)
		.get(sessionId);
	return row?.count ?? 0;
}

export function getSessionFilesModified(sessionId: string): string[] {
	const rows = db
		.query<{ files_modified: string }, [string]>(
			"SELECT DISTINCT files_modified FROM observations WHERE session_id = ? AND files_modified IS NOT NULL",
		)
		.all(sessionId);

	const files = new Set<string>();
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.files_modified) as string[];
			for (const f of parsed) files.add(f);
		} catch {
			/* skip malformed */
		}
	}
	return [...files];
}

export function markObservationsCompressed(sessionId: string): void {
	db.query("UPDATE observations SET compressed = 1 WHERE session_id = ? AND compressed = 0").run(
		sessionId,
	);
}

export function getStaleActiveSessions(intervalMinutes: number): SessionRow[] {
	return db
		.query<SessionRow, [number]>(
			`SELECT DISTINCT s.* FROM sessions s
			 JOIN observations o ON o.session_id = s.id
			 WHERE s.status = 'active' AND o.compressed = 0
			 AND o.created_at <= datetime('now', '-' || ? || ' minutes')
			 ORDER BY s.started_at ASC`,
		)
		.all(intervalMinutes);
}

export function getRecentSessionSummaries(opts: {
	userId: string;
	project?: string | null;
	limit?: number;
}): SessionRow[] {
	const conditions = ["ak.user_id = ?", "s.summary IS NOT NULL"];
	const params: (string | number)[] = [opts.userId];

	if (opts.project) {
		conditions.push("s.project = ?");
		params.push(opts.project);
	}

	const limit = opts.limit ?? 5;
	params.push(limit);

	return db
		.query<SessionRow, (string | number)[]>(
			`SELECT s.* FROM sessions s
			 JOIN api_keys ak ON s.api_key_id = ak.id
			 WHERE ${conditions.join(" AND ")}
			 ORDER BY s.started_at DESC
			 LIMIT ?`,
		)
		.all(...params);
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
