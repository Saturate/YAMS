import { Hono } from "hono";
import { jwtMiddleware } from "./auth.js";
import { UserScope } from "./db.js";
import type { AppEnv } from "./env.js";
import { getGraphProviderOrNull } from "./graph.js";

export const graphApi = new Hono<AppEnv>();

graphApi.use("*", jwtMiddleware);

/**
 * GET /api/graph
 * Returns nodes + edges for the current user's memory graph.
 * Query params: project, scope, limit (node limit, default 200)
 *
 * Response shape designed for d3-force / three.js consumption:
 * {
 *   nodes: [{ id, summary, scope, project, created_at }],
 *   edges: [{ id, source, target, edge_type, metadata, created_at }]
 * }
 */
graphApi.get("/", async (c) => {
	const graph = getGraphProviderOrNull();
	if (!graph) {
		return c.json({ nodes: [], edges: [] });
	}

	const db = new UserScope(c.get("userId"));
	const project = c.req.query("project");
	const scope = c.req.query("scope") as "session" | "project" | "global" | undefined;
	const limit = Math.min(Number(c.req.query("limit")) || 200, 500);

	const memories = db.listMemories({
		gitRemote: project,
		scope,
		limit,
	});

	if (memories.length === 0) {
		return c.json({ nodes: [], edges: [] });
	}

	const memoryIds = new Set(memories.map((m) => m.id));

	// Collect all edges between the user's memories
	const edgeMap = new Map<
		string,
		{
			id: string;
			source: string;
			target: string;
			edge_type: string;
			metadata: Record<string, unknown> | null;
			created_at: string;
		}
	>();

	for (const memory of memories) {
		const neighbors = await graph.getNeighbors(memory.id, { direction: "outgoing", limit: 100 });
		for (const n of neighbors) {
			// Only include edges where both endpoints are in the result set
			if (!memoryIds.has(n.memory_id)) continue;
			if (edgeMap.has(n.edge_id)) continue;

			const edges = await graph.getEdgesBetween(memory.id, n.memory_id);
			for (const edge of edges) {
				if (edgeMap.has(edge.id)) continue;
				if (!memoryIds.has(edge.source_memory_id) || !memoryIds.has(edge.target_memory_id))
					continue;
				edgeMap.set(edge.id, {
					id: edge.id,
					source: edge.source_memory_id,
					target: edge.target_memory_id,
					edge_type: edge.edge_type,
					metadata: edge.metadata,
					created_at: edge.created_at,
				});
			}
		}
	}

	const nodes = memories.map((m) => ({
		id: m.id,
		summary: m.summary,
		scope: m.scope,
		project: m.git_remote,
		created_at: m.created_at,
	}));

	return c.json({
		nodes,
		edges: [...edgeMap.values()],
	});
});
