import { Hono } from "hono";
import { jwtMiddleware } from "./auth.js";
import {
	countMemories,
	deleteMemory,
	getMemory,
	listDistinctGitRemotes,
	listMemories,
} from "./db.js";
import { listApiKeys } from "./db.js";
import { deletePoint } from "./qdrant.js";

const admin = new Hono();

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

// --- Memories ---

admin.get("/memories", (c) => {
	const gitRemote = c.req.query("git_remote");
	const scope = c.req.query("scope");
	const limit = Number(c.req.query("limit")) || 50;
	const offset = Number(c.req.query("offset")) || 0;

	const memories = listMemories({ gitRemote, scope, limit, offset });
	const total = countMemories();

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
	} catch {
		// Qdrant might be down — SQLite deletion is still valid
	}

	return c.json({ id, deleted: true });
});

export { admin };
