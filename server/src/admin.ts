import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { jwtMiddleware } from "./auth.js";
import { parseSummary, setCompressionProvider } from "./compression.js";
import {
	countMemories,
	countObservations,
	countSessions,
	deleteConfig,
	deleteMemory,
	deleteSession,
	getApiKeyById,
	getConfig,
	getMemory,
	getSession,
	listApiKeys,
	listDistinctGitRemotes,
	listDistinctScopes,
	listMemories,
	listObservations,
	listSessions,
	setConfig,
} from "./db.js";
import { getProvider } from "./embeddings.js";
import type { AppEnv } from "./env.js";
import { resetPrivacyCache } from "./privacy.js";
import { deletePoint, searchMemories } from "./qdrant.js";

const log = getLogger(["yams", "admin"]);

const admin = new Hono<AppEnv>();

admin.use("*", jwtMiddleware);

// --- Stats ---

admin.get("/stats", (c) => {
	const isAdmin = c.get("role") === "admin";
	const userId = isAdmin ? undefined : c.get("userId");

	const memoryCount = countMemories({ userId });
	const keys = isAdmin ? listApiKeys() : listApiKeys(c.get("userId"));
	const projects = listDistinctGitRemotes(userId);
	const activeKeys = keys.filter((k) => k.is_active).length;
	const totalSessions = countSessions({ userId });
	const activeSessions = countSessions({ userId, status: "active" });

	return c.json({
		memories: memoryCount,
		keys: { total: keys.length, active: activeKeys },
		projects: projects.length,
		sessions: { total: totalSessions, active: activeSessions },
	});
});

// --- Filters ---

admin.get("/filters", (c) => {
	const isAdmin = c.get("role") === "admin";
	const userId = isAdmin ? undefined : c.get("userId");
	const projects = listDistinctGitRemotes(userId);
	const scopes = listDistinctScopes(userId);
	return c.json({ projects, scopes });
});

// --- Search ---

admin.post("/search", async (c) => {
	const body = await c.req.json<{
		query?: string;
		git_remote?: string;
		scope?: string;
		limit?: number;
	}>();

	const query = body.query?.trim();
	if (!query) {
		return c.json({ error: "query is required." }, 400);
	}

	const limit = body.limit ?? 10;
	const isAdmin = c.get("role") === "admin";

	try {
		const vector = await getProvider().embed(query);
		const filter: { git_remote?: string; scope?: string; user_id?: string } = {};
		if (body.git_remote) filter.git_remote = body.git_remote;
		if (body.scope) filter.scope = body.scope;
		if (!isAdmin) filter.user_id = c.get("userId");

		const results = await searchMemories(
			vector,
			Object.keys(filter).length > 0 ? filter : undefined,
			limit,
		);

		// Enrich with full memory data from SQLite
		const memories = results
			.map((r) => {
				const memory = getMemory(String(r.id));
				if (!memory) return null;
				return { score: r.score, ...memory };
			})
			.filter((m) => m !== null);

		return c.json({ results: memories });
	} catch (err) {
		if (err instanceof Error) log.error("Search failed: {error}", { error: err.message });
		return c.json({ error: "Search service unavailable." }, 502);
	}
});

// --- Memories ---

admin.get("/memories", (c) => {
	const gitRemote = c.req.query("git_remote");
	const scope = c.req.query("scope");
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
	const isAdmin = c.get("role") === "admin";
	const userId = isAdmin ? undefined : c.get("userId");

	const memories = listMemories({ gitRemote, scope, limit, offset, userId });
	const total = countMemories({ gitRemote, scope, userId });

	return c.json({ memories, total });
});

admin.delete("/memories/:id", async (c) => {
	const id = c.req.param("id");
	const memory = getMemory(id);

	if (!memory) {
		return c.json({ error: "Memory not found." }, 404);
	}

	// Non-admin users can only delete their own memories
	if (c.get("role") !== "admin") {
		const key = getApiKeyById(memory.api_key_id);
		if (!key || key.user_id !== c.get("userId")) {
			return c.json({ error: "Memory not found." }, 404);
		}
	}

	deleteMemory(id);

	try {
		await deletePoint(id);
	} catch (err) {
		log.warn("Qdrant delete failed for {id}: {error}", {
			id,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return c.json({ id, deleted: true });
});

// --- Sessions ---

admin.get("/sessions", (c) => {
	const isAdmin = c.get("role") === "admin";
	const userId = isAdmin ? undefined : c.get("userId");
	const project = c.req.query("project") || undefined;
	const status = c.req.query("status") || undefined;
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

	const sessionsList = listSessions({ userId, project, status, limit, offset });
	const total = countSessions({ userId, status });

	const enriched = sessionsList.map((s) => ({
		...s,
		observation_count: countObservations(s.id),
	}));

	return c.json({ sessions: enriched, total });
});

admin.get("/sessions/:id", (c) => {
	const id = c.req.param("id");
	const session = getSession(id);

	if (!session) {
		return c.json({ error: "Session not found." }, 404);
	}

	// Non-admin: check ownership
	if (c.get("role") !== "admin") {
		const key = getApiKeyById(session.api_key_id);
		if (!key || key.user_id !== c.get("userId")) {
			return c.json({ error: "Session not found." }, 404);
		}
	}

	const observations = listObservations(session.id);
	const parsed_summary = session.summary ? parseSummary(session.summary) : null;
	return c.json({ session, parsed_summary, observations });
});

admin.delete("/sessions/:id", (c) => {
	const id = c.req.param("id");
	const session = getSession(id);

	if (!session) {
		return c.json({ error: "Session not found." }, 404);
	}

	if (c.get("role") !== "admin") {
		const key = getApiKeyById(session.api_key_id);
		if (!key || key.user_id !== c.get("userId")) {
			return c.json({ error: "Session not found." }, 404);
		}
	}

	deleteSession(id);
	return c.json({ id, deleted: true });
});

// --- Settings (config) ---

const CONFIG_KEYS = [
	"memory_mode",
	"compression_mode",
	"compression_provider",
	"compression_model",
	"compression_api_key",
	"compression_base_url",
	"compression_batch_size",
	"compression_interval_minutes",
	"session_context_count",
	"privacy_patterns",
	"dedup_threshold",
] as const;

admin.get("/settings", (c) => {
	if (c.get("role") !== "admin") {
		return c.json({ error: "Forbidden." }, 403);
	}

	const settings: Record<string, string | null> = {};
	for (const key of CONFIG_KEYS) {
		const value = getConfig(key) ?? null;
		// Never expose secret values in plaintext
		if (key === "compression_api_key" && value) {
			settings[key] = `${value.slice(0, 4)}${"*".repeat(8)}`;
		} else {
			settings[key] = value;
		}
	}

	return c.json({ settings });
});

admin.put("/settings", async (c) => {
	if (c.get("role") !== "admin") {
		return c.json({ error: "Forbidden." }, 403);
	}

	const body = await c.req.json<Record<string, string | null>>();

	for (const [key, value] of Object.entries(body)) {
		if (!CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number])) {
			return c.json({ error: `Unknown setting: ${key}` }, 400);
		}
		if (value !== null && typeof value !== "string") {
			return c.json({ error: `Setting ${key} must be a string or null.` }, 400);
		}

		// Validate specific settings
		if (key === "compression_base_url" && value !== null) {
			try {
				const url = new URL(value);
				if (url.protocol !== "https:" && url.protocol !== "http:") {
					return c.json({ error: "compression_base_url must use http or https." }, 400);
				}
			} catch {
				return c.json({ error: "compression_base_url must be a valid URL." }, 400);
			}
		}
		if (key === "memory_mode" && value !== null && value !== "simple" && value !== "full") {
			return c.json({ error: "memory_mode must be 'simple' or 'full'." }, 400);
		}
		if (key === "compression_mode" && value !== null && value !== "client" && value !== "server") {
			return c.json({ error: "compression_mode must be 'client' or 'server'." }, 400);
		}
		if (key === "compression_provider" && value !== null) {
			if (!["anthropic", "openrouter", "ollama"].includes(value)) {
				return c.json(
					{ error: "compression_provider must be 'anthropic', 'openrouter', or 'ollama'." },
					400,
				);
			}
		}
		if (key === "compression_batch_size" && value !== null) {
			const num = Number(value);
			if (!Number.isInteger(num) || num < 5 || num > 100) {
				return c.json(
					{ error: "compression_batch_size must be an integer between 5 and 100." },
					400,
				);
			}
		}
		if (key === "compression_interval_minutes" && value !== null) {
			const num = Number(value);
			if (!Number.isInteger(num) || num < 5 || num > 60) {
				return c.json(
					{ error: "compression_interval_minutes must be an integer between 5 and 60." },
					400,
				);
			}
		}
		if (key === "privacy_patterns" && value !== null) {
			const lines = value.split("\n").filter((l) => {
				const t = l.trim();
				return t && !t.startsWith("#");
			});
			for (const line of lines) {
				try {
					new RegExp(line.trim(), "gi");
				} catch {
					return c.json({ error: `Invalid regex pattern: ${line.trim()}` }, 400);
				}
			}
		}
		if (key === "session_context_count" && value !== null) {
			const num = Number(value);
			if (!Number.isInteger(num) || num < 1 || num > 20) {
				return c.json({ error: "session_context_count must be an integer between 1 and 20." }, 400);
			}
		}
		if (key === "dedup_threshold" && value !== null) {
			const num = Number(value);
			if (!Number.isFinite(num) || num < 0.5 || num > 1.0) {
				return c.json({ error: "dedup_threshold must be a number between 0.5 and 1.0." }, 400);
			}
		}

		if (value === null) {
			deleteConfig(key);
		} else {
			setConfig(key, value);
		}
	}

	// Reset cached compression provider when relevant settings change
	const compressionKeys = [
		"compression_provider",
		"compression_model",
		"compression_api_key",
		"compression_base_url",
	];
	if (Object.keys(body).some((k) => compressionKeys.includes(k))) {
		setCompressionProvider(null);
	}
	if ("privacy_patterns" in body) {
		resetPrivacyCache();
	}

	return c.json({ ok: true });
});

export { admin };
