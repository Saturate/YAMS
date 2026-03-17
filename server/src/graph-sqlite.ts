import { getDb } from "./db.js";
import type {
	EdgeType,
	GraphEdge,
	GraphNeighbor,
	GraphProvider,
	TraversalResult,
} from "./graph.js";

interface EdgeRow {
	id: string;
	source_memory_id: string;
	target_memory_id: string;
	edge_type: string;
	metadata: string | null;
	created_at: string;
	created_by: string;
}

function rowToEdge(row: EdgeRow): GraphEdge {
	return {
		...row,
		edge_type: row.edge_type as EdgeType,
		metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
	};
}

export class SqliteGraphProvider implements GraphProvider {
	readonly name = "sqlite";

	async init(): Promise<void> {
		// Table created in db.ts initDb — nothing extra needed
	}

	async addEdge(params: {
		sourceMemoryId: string;
		targetMemoryId: string;
		edgeType: EdgeType;
		userId: string;
		metadata?: Record<string, unknown> | null;
	}): Promise<GraphEdge> {
		const db = getDb();
		const id = crypto.randomUUID();
		const metaJson = params.metadata ? JSON.stringify(params.metadata) : null;

		try {
			db.query(
				"INSERT INTO graph_edges (id, source_memory_id, target_memory_id, edge_type, metadata, created_by) VALUES (?, ?, ?, ?, ?, ?)",
			).run(
				id,
				params.sourceMemoryId,
				params.targetMemoryId,
				params.edgeType,
				metaJson,
				params.userId,
			);
		} catch (err) {
			if (err instanceof Error) {
				if (err.message.includes("UNIQUE constraint")) {
					throw new Error(
						`Edge ${params.edgeType} already exists between ${params.sourceMemoryId} and ${params.targetMemoryId}`,
					);
				}
				if (err.message.includes("FOREIGN KEY constraint")) {
					throw new Error("One or both memory IDs do not exist");
				}
			}
			throw err;
		}

		const row = db.query<EdgeRow, [string]>("SELECT * FROM graph_edges WHERE id = ?").get(id);

		if (!row) throw new Error(`Edge ${id} not found`);
		return rowToEdge(row);
	}

	async getEdge(edgeId: string): Promise<GraphEdge | null> {
		const row = getDb()
			.query<EdgeRow, [string]>("SELECT * FROM graph_edges WHERE id = ?")
			.get(edgeId);
		return row ? rowToEdge(row) : null;
	}

	async removeEdge(edgeId: string): Promise<boolean> {
		const result = getDb().query("DELETE FROM graph_edges WHERE id = ?").run(edgeId);
		return result.changes > 0;
	}

	async removeEdgesForMemory(memoryId: string): Promise<number> {
		const result = getDb()
			.query("DELETE FROM graph_edges WHERE source_memory_id = ? OR target_memory_id = ?")
			.run(memoryId, memoryId);
		return result.changes;
	}

	async getNeighbors(
		memoryId: string,
		opts?: {
			edgeType?: EdgeType;
			direction?: "outgoing" | "incoming" | "both";
			limit?: number;
		},
	): Promise<GraphNeighbor[]> {
		const db = getDb();
		const direction = opts?.direction ?? "both";
		const limit = opts?.limit ?? 100;
		const results: GraphNeighbor[] = [];

		if (direction === "outgoing" || direction === "both") {
			const conditions = ["source_memory_id = ?"];
			const params: (string | number)[] = [memoryId];
			if (opts?.edgeType) {
				conditions.push("edge_type = ?");
				params.push(opts.edgeType);
			}
			params.push(limit);

			const rows = db
				.query<EdgeRow, (string | number)[]>(
					`SELECT * FROM graph_edges WHERE ${conditions.join(" AND ")} LIMIT ?`,
				)
				.all(...params);

			for (const row of rows) {
				results.push({
					memory_id: row.target_memory_id,
					edge_id: row.id,
					edge_type: row.edge_type as EdgeType,
					direction: "outgoing",
				});
			}
		}

		if (direction === "incoming" || direction === "both") {
			const conditions = ["target_memory_id = ?"];
			const params: (string | number)[] = [memoryId];
			if (opts?.edgeType) {
				conditions.push("edge_type = ?");
				params.push(opts.edgeType);
			}
			params.push(limit);

			const rows = db
				.query<EdgeRow, (string | number)[]>(
					`SELECT * FROM graph_edges WHERE ${conditions.join(" AND ")} LIMIT ?`,
				)
				.all(...params);

			for (const row of rows) {
				results.push({
					memory_id: row.source_memory_id,
					edge_id: row.id,
					edge_type: row.edge_type as EdgeType,
					direction: "incoming",
				});
			}
		}

		return results.slice(0, limit);
	}

	async traverse(
		memoryId: string,
		opts?: {
			edgeTypes?: EdgeType[];
			maxDepth?: number;
			limit?: number;
		},
	): Promise<TraversalResult[]> {
		const maxDepth = Math.min(opts?.maxDepth ?? 3, 5);
		const limit = opts?.limit ?? 50;
		const edgeTypes = opts?.edgeTypes;
		// Cap per-node fan-out and total queue to bound resource usage
		const perNodeLimit = 50;
		const maxQueueSize = 500;

		const visited = new Set<string>([memoryId]);
		const results: TraversalResult[] = [];

		// BFS queue: [memoryId, depth, path]
		const queue: Array<[string, number, Array<{ edge_id: string; edge_type: EdgeType }>]> = [
			[memoryId, 0, []],
		];

		while (queue.length > 0 && results.length < limit) {
			const item = queue.shift();
			if (!item) break;
			const [currentId, depth, path] = item;

			if (depth > 0) {
				results.push({ memory_id: currentId, depth, path });
			}

			if (depth >= maxDepth) continue;

			const neighbors = await this.getNeighbors(currentId, {
				edgeType: undefined,
				direction: "both",
				limit: perNodeLimit,
			});

			for (const neighbor of neighbors) {
				if (visited.has(neighbor.memory_id)) continue;
				if (edgeTypes && !edgeTypes.includes(neighbor.edge_type)) continue;
				if (queue.length >= maxQueueSize) break;

				visited.add(neighbor.memory_id);
				queue.push([
					neighbor.memory_id,
					depth + 1,
					[...path, { edge_id: neighbor.edge_id, edge_type: neighbor.edge_type }],
				]);
			}
		}

		return results;
	}

	async getEdgesBetween(memoryIdA: string, memoryIdB: string): Promise<GraphEdge[]> {
		const rows = getDb()
			.query<EdgeRow, [string, string, string, string]>(
				"SELECT * FROM graph_edges WHERE (source_memory_id = ? AND target_memory_id = ?) OR (source_memory_id = ? AND target_memory_id = ?)",
			)
			.all(memoryIdA, memoryIdB, memoryIdB, memoryIdA);

		return rows.map(rowToEdge);
	}

	async healthy(): Promise<boolean> {
		try {
			getDb().query("SELECT 1 FROM graph_edges LIMIT 1").get();
			return true;
		} catch {
			return false;
		}
	}
}
