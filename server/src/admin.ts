import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { jwtMiddleware } from "./auth.js";
import {
	countMemories,
	deleteMemory,
	getMemory,
	listDistinctGitRemotes,
	listDistinctScopes,
	listMemories,
} from "./db.js";
import { listApiKeys } from "./db.js";
import { getProvider } from "./embeddings.js";
import type { AppEnv } from "./env.js";
import { deletePoint, searchMemories } from "./qdrant.js";

const log = getLogger(["yams", "admin"]);

const admin = new Hono<AppEnv>();

admin.use("*", jwtMiddleware);

// --- Stats ---

admin.get("/stats", (c) => {
	const memoryCount = countMemories();
	const keys = listApiKeys();
	const projects = listDistinctGitRemotes();
	const activeKeys = keys.filter((k) => k.is_active).length;

	return c.json({
		memories: memoryCount,
		keys: { total: keys.length, active: activeKeys },
		projects: projects.length,
	});
});

// --- Filters ---

admin.get("/filters", (c) => {
	const projects = listDistinctGitRemotes();
	const scopes = listDistinctScopes();
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

	try {
		const vector = await getProvider().embed(query);
		const filter: { git_remote?: string; scope?: string } = {};
		if (body.git_remote) filter.git_remote = body.git_remote;
		if (body.scope) filter.scope = body.scope;

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

	const memories = listMemories({ gitRemote, scope, limit, offset });
	const total = countMemories({ gitRemote, scope });

	return c.json({ memories, total });
});

admin.delete("/memories/:id", async (c) => {
	const id = c.req.param("id");
	const memory = getMemory(id);

	if (!memory) {
		return c.json({ error: "Memory not found." }, 404);
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

export { admin };
