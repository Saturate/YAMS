import { beforeEach, describe, expect, test } from "bun:test";
import { createApiKey, createMemory, createUser, deleteMemory, getDb } from "./db.js";
import { SqliteGraphProvider } from "./graph-sqlite.js";
import { setGraphProvider } from "./graph.js";
import { createTestApp } from "./test-helpers.js";

let graph: SqliteGraphProvider;
let userId: string;
let apiKeyId: string;
let memA: string;
let memB: string;
let memC: string;

function setup() {
	createTestApp();
	graph = new SqliteGraphProvider();
	setGraphProvider(graph);

	userId = createUser("graphuser", "hash", { role: "admin" });
	apiKeyId = createApiKey({
		userId,
		label: "test",
		keyHash: `hash-${crypto.randomUUID()}`,
		keyPrefix: "ym_test",
		expiresAt: null,
	});

	memA = crypto.randomUUID();
	memB = crypto.randomUUID();
	memC = crypto.randomUUID();
	createMemory({ id: memA, apiKeyId, scope: "global", summary: "Memory A" });
	createMemory({ id: memB, apiKeyId, scope: "global", summary: "Memory B" });
	createMemory({ id: memC, apiKeyId, scope: "global", summary: "Memory C" });
}

describe("SqliteGraphProvider", () => {
	beforeEach(setup);

	describe("addEdge", () => {
		test("creates an edge between two memories", async () => {
			const edge = await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});

			expect(edge.id).toBeDefined();
			expect(edge.source_memory_id).toBe(memA);
			expect(edge.target_memory_id).toBe(memB);
			expect(edge.edge_type).toBe("related_to");
			expect(edge.created_by).toBe(userId);
			expect(edge.created_at).toBeDefined();
		});

		test("stores metadata as JSON", async () => {
			const meta = { reason: "test link", confidence: 0.9 };
			const edge = await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "caused_by",
				userId,
				metadata: meta,
			});

			expect(edge.metadata).toEqual(meta);
		});

		test("rejects duplicate edge (same source, target, type)", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});

			expect(
				graph.addEdge({
					sourceMemoryId: memA,
					targetMemoryId: memB,
					edgeType: "related_to",
					userId,
				}),
			).rejects.toThrow("already exists");
		});

		test("allows different edge types between same memories", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});

			const edge2 = await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "supersedes",
				userId,
			});

			expect(edge2.edge_type).toBe("supersedes");
		});

		test("rejects nonexistent memory IDs", async () => {
			expect(
				graph.addEdge({
					sourceMemoryId: "nonexistent",
					targetMemoryId: memB,
					edgeType: "related_to",
					userId,
				}),
			).rejects.toThrow("do not exist");
		});
	});

	describe("removeEdge", () => {
		test("removes an existing edge", async () => {
			const edge = await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});

			const removed = await graph.removeEdge(edge.id);
			expect(removed).toBe(true);

			const neighbors = await graph.getNeighbors(memA);
			expect(neighbors).toHaveLength(0);
		});

		test("returns false for nonexistent edge", async () => {
			const removed = await graph.removeEdge("nonexistent");
			expect(removed).toBe(false);
		});
	});

	describe("removeEdgesForMemory", () => {
		test("removes all edges involving a memory", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memC,
				targetMemoryId: memA,
				edgeType: "caused_by",
				userId,
			});

			const count = await graph.removeEdgesForMemory(memA);
			expect(count).toBe(2);

			expect(await graph.getNeighbors(memA)).toHaveLength(0);
			expect(await graph.getNeighbors(memB)).toHaveLength(0);
			expect(await graph.getNeighbors(memC)).toHaveLength(0);
		});
	});

	describe("getNeighbors", () => {
		test("returns outgoing and incoming neighbors", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memC,
				targetMemoryId: memA,
				edgeType: "caused_by",
				userId,
			});

			const all = await graph.getNeighbors(memA);
			expect(all).toHaveLength(2);

			const outgoing = await graph.getNeighbors(memA, { direction: "outgoing" });
			expect(outgoing).toHaveLength(1);
			expect(outgoing[0]?.memory_id).toBe(memB);
			expect(outgoing[0]?.direction).toBe("outgoing");

			const incoming = await graph.getNeighbors(memA, { direction: "incoming" });
			expect(incoming).toHaveLength(1);
			expect(incoming[0]?.memory_id).toBe(memC);
			expect(incoming[0]?.direction).toBe("incoming");
		});

		test("filters by edge type", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memC,
				edgeType: "contradicts",
				userId,
			});

			const related = await graph.getNeighbors(memA, { edgeType: "related_to" });
			expect(related).toHaveLength(1);
			expect(related[0]?.memory_id).toBe(memB);
		});

		test("respects limit", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memC,
				edgeType: "caused_by",
				userId,
			});

			const limited = await graph.getNeighbors(memA, { limit: 1 });
			expect(limited).toHaveLength(1);
		});
	});

	describe("traverse", () => {
		test("walks graph via BFS", async () => {
			// A -> B -> C
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memB,
				targetMemoryId: memC,
				edgeType: "related_to",
				userId,
			});

			const results = await graph.traverse(memA, { maxDepth: 3 });
			expect(results).toHaveLength(2);

			const depths = results.map((r) => r.depth);
			expect(depths).toContain(1);
			expect(depths).toContain(2);

			const atDepth2 = results.find((r) => r.depth === 2);
			expect(atDepth2?.memory_id).toBe(memC);
			expect(atDepth2?.path).toHaveLength(2);
		});

		test("respects maxDepth", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memB,
				targetMemoryId: memC,
				edgeType: "related_to",
				userId,
			});

			const results = await graph.traverse(memA, { maxDepth: 1 });
			expect(results).toHaveLength(1);
			expect(results[0]?.memory_id).toBe(memB);
		});

		test("filters by edge types", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memC,
				edgeType: "contradicts",
				userId,
			});

			const results = await graph.traverse(memA, { edgeTypes: ["related_to"] });
			expect(results).toHaveLength(1);
			expect(results[0]?.memory_id).toBe(memB);
		});

		test("handles cycles without infinite loop", async () => {
			// A -> B -> A (cycle)
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memB,
				targetMemoryId: memA,
				edgeType: "related_to",
				userId,
			});

			const results = await graph.traverse(memA, { maxDepth: 5 });
			// Should visit B only once despite cycle
			expect(results).toHaveLength(1);
			expect(results[0]?.memory_id).toBe(memB);
		});

		test("respects limit", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memC,
				edgeType: "related_to",
				userId,
			});

			const results = await graph.traverse(memA, { limit: 1 });
			expect(results).toHaveLength(1);
		});
	});

	describe("getEdgesBetween", () => {
		test("returns edges in both directions", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});
			await graph.addEdge({
				sourceMemoryId: memB,
				targetMemoryId: memA,
				edgeType: "supersedes",
				userId,
			});

			const edges = await graph.getEdgesBetween(memA, memB);
			expect(edges).toHaveLength(2);
		});

		test("returns empty for unconnected memories", async () => {
			const edges = await graph.getEdgesBetween(memA, memB);
			expect(edges).toHaveLength(0);
		});
	});

	describe("ON DELETE CASCADE", () => {
		test("edges are removed when source memory is deleted", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});

			deleteMemory(memA);

			const neighbors = await graph.getNeighbors(memB);
			expect(neighbors).toHaveLength(0);
		});

		test("edges are removed when target memory is deleted", async () => {
			await graph.addEdge({
				sourceMemoryId: memA,
				targetMemoryId: memB,
				edgeType: "related_to",
				userId,
			});

			deleteMemory(memB);

			const neighbors = await graph.getNeighbors(memA);
			expect(neighbors).toHaveLength(0);
		});
	});

	describe("healthy", () => {
		test("returns true when table exists", async () => {
			expect(await graph.healthy()).toBe(true);
		});
	});
});
