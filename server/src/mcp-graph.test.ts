import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getMemory } from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import { SqliteGraphProvider } from "./graph-sqlite.js";
import { setGraphProvider } from "./graph.js";
import type { StorageProvider, VectorSearchResult } from "./storage.js";
import { setStorageProvider } from "./storage.js";
import { createRegularUser, createTestApp, getToken, setupAdmin } from "./test-helpers.js";

const mockVector = new Array(768).fill(0.1) as number[];
const mockEmbed = mock(() => Promise.resolve(mockVector));
const mockUpsert = mock(() => Promise.resolve());
const mockDelete = mock(() => Promise.resolve());
const mockSearch = mock(() => Promise.resolve([] as VectorSearchResult[]));

const mockProvider: EmbeddingProvider = {
	name: "mock",
	dimensions: 768,
	embed: mockEmbed,
};

const mockStorage: StorageProvider = {
	name: "mock",
	init: () => Promise.resolve(),
	upsert: mockUpsert,
	search: mockSearch,
	delete: mockDelete,
	healthy: () => Promise.resolve(true),
};

interface JsonRpcResponse {
	jsonrpc: string;
	id: number;
	result?: {
		content?: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	error?: { code: number; message: string };
}

const MCP_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
} as const;

async function createApiKey(app: ReturnType<typeof createTestApp>, jwtToken?: string) {
	const token = jwtToken ?? (await getToken(app));
	const res = await app.request("/api/keys", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: "graph-test" }),
	});
	return ((await res.json()) as { key: string }).key;
}

async function mcpCallTool(
	app: ReturnType<typeof createTestApp>,
	apiKey: string,
	name: string,
	args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
	const res = await app.request("/mcp", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, ...MCP_HEADERS },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name, arguments: args },
			id: 2,
		}),
	});
	return (await res.json()) as JsonRpcResponse;
}

function parseResult(data: JsonRpcResponse): unknown {
	return JSON.parse(data.result?.content?.[0]?.text ?? "{}");
}

/** Store a memory via MCP and return its ID */
async function storeMemory(
	app: ReturnType<typeof createTestApp>,
	apiKey: string,
	content: string,
): Promise<string> {
	const data = await mcpCallTool(app, apiKey, "remember", {
		content,
		scope: "global",
		force: true,
	});
	return (parseResult(data) as { id: string }).id;
}

describe("MCP graph tools", () => {
	beforeEach(() => {
		setProvider(mockProvider);
		setStorageProvider(mockStorage);
		setGraphProvider(new SqliteGraphProvider());
		mockEmbed.mockClear();
		mockUpsert.mockClear();
		mockDelete.mockClear();
		mockSearch.mockReset();
		mockSearch.mockImplementation(() => Promise.resolve([] as VectorSearchResult[]));
	});

	afterEach(() => {
		setProvider(mockProvider);
		setStorageProvider(null);
		setGraphProvider(null);
	});

	// --- link ---

	test("link creates an edge between two memories", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Memory A");
		const idB = await storeMemory(app, key, "Memory B");

		const data = await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});

		expect(data.result?.isError).toBeUndefined();
		const edge = parseResult(data) as {
			id: string;
			source_memory_id: string;
			target_memory_id: string;
			edge_type: string;
		};
		expect(edge.source_memory_id).toBe(idA);
		expect(edge.target_memory_id).toBe(idB);
		expect(edge.edge_type).toBe("related_to");
	});

	test("link rejects nonexistent source", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idB = await storeMemory(app, key, "Memory B");

		const data = await mcpCallTool(app, key, "link", {
			source_id: "nonexistent",
			target_id: idB,
			edge_type: "related_to",
		});

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Source memory not found.");
	});

	test("link rejects nonexistent target", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Memory A");

		const data = await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: "nonexistent",
			edge_type: "related_to",
		});

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Target memory not found.");
	});

	test("link prevents linking to another user's memory", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const adminToken = await getToken(app);
		const adminKey = await createApiKey(app);

		const adminMemory = await storeMemory(app, adminKey, "Admin's memory");

		const user = await createRegularUser(app, adminToken);
		const userKey = await createApiKey(app, user.token);
		const userMemory = await storeMemory(app, userKey, "User's memory");

		// User tries to link their memory to admin's
		const data = await mcpCallTool(app, userKey, "link", {
			source_id: userMemory,
			target_id: adminMemory,
			edge_type: "related_to",
		});

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Target memory not found.");
	});

	test("link rejects duplicate edge", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Memory A");
		const idB = await storeMemory(app, key, "Memory B");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});

		const data = await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toContain("already exists");
	});

	// --- unlink ---

	test("unlink removes an edge the caller owns", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Memory A");
		const idB = await storeMemory(app, key, "Memory B");

		const linkData = await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});
		const edgeId = (parseResult(linkData) as { id: string }).id;

		const data = await mcpCallTool(app, key, "unlink", { edge_id: edgeId });

		expect(data.result?.isError).toBeUndefined();
		const result = parseResult(data) as { edge_id: string; removed: boolean };
		expect(result.removed).toBe(true);
	});

	test("unlink returns error for nonexistent edge", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const data = await mcpCallTool(app, key, "unlink", { edge_id: "nonexistent" });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Edge not found.");
	});

	test("unlink prevents deleting another user's edge", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const adminToken = await getToken(app);
		const adminKey = await createApiKey(app);

		// Admin creates memories and links them
		const idA = await storeMemory(app, adminKey, "Admin A");
		const idB = await storeMemory(app, adminKey, "Admin B");
		const linkData = await mcpCallTool(app, adminKey, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});
		const edgeId = (parseResult(linkData) as { id: string }).id;

		// Regular user tries to unlink admin's edge
		const user = await createRegularUser(app, adminToken);
		const userKey = await createApiKey(app, user.token);

		const data = await mcpCallTool(app, userKey, "unlink", { edge_id: edgeId });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Edge not found.");
	});

	// --- related ---

	test("related returns neighbors with summaries", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Memory A content");
		const idB = await storeMemory(app, key, "Memory B content");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "caused_by",
		});

		const data = await mcpCallTool(app, key, "related", { memory_id: idA });

		expect(data.result?.isError).toBeUndefined();
		const neighbors = parseResult(data) as Array<{
			memory_id: string;
			edge_type: string;
			summary: string;
		}>;
		expect(neighbors).toHaveLength(1);
		expect(neighbors[0]?.memory_id).toBe(idB);
		expect(neighbors[0]?.edge_type).toBe("caused_by");
		expect(neighbors[0]?.summary).toBe("Memory B content");
	});

	test("related filters by edge type", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "A");
		const idB = await storeMemory(app, key, "B");
		const idC = await storeMemory(app, key, "C");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});
		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idC,
			edge_type: "contradicts",
		});

		const data = await mcpCallTool(app, key, "related", {
			memory_id: idA,
			edge_type: "contradicts",
		});

		const neighbors = parseResult(data) as Array<{ memory_id: string }>;
		expect(neighbors).toHaveLength(1);
		expect(neighbors[0]?.memory_id).toBe(idC);
	});

	test("related hides other user's memories", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const adminToken = await getToken(app);
		const adminKey = await createApiKey(app);

		const adminMemA = await storeMemory(app, adminKey, "Admin A");
		const adminMemB = await storeMemory(app, adminKey, "Admin B");

		await mcpCallTool(app, adminKey, "link", {
			source_id: adminMemA,
			target_id: adminMemB,
			edge_type: "related_to",
		});

		// Regular user shouldn't even be able to query admin's memory
		const user = await createRegularUser(app, adminToken);
		const userKey = await createApiKey(app, user.token);

		const data = await mcpCallTool(app, userKey, "related", { memory_id: adminMemA });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Memory not found.");
	});

	test("related returns not found for nonexistent memory", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const data = await mcpCallTool(app, key, "related", { memory_id: "nope" });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Memory not found.");
	});

	// --- traverse ---

	test("traverse walks graph and returns summaries", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Root");
		const idB = await storeMemory(app, key, "Child");
		const idC = await storeMemory(app, key, "Grandchild");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});
		await mcpCallTool(app, key, "link", {
			source_id: idB,
			target_id: idC,
			edge_type: "caused_by",
		});

		const data = await mcpCallTool(app, key, "traverse", {
			memory_id: idA,
			max_depth: 3,
		});

		expect(data.result?.isError).toBeUndefined();
		const results = parseResult(data) as Array<{
			memory_id: string;
			depth: number;
			summary: string;
		}>;
		expect(results).toHaveLength(2);

		const atDepth1 = results.find((r) => r.depth === 1);
		expect(atDepth1?.memory_id).toBe(idB);
		expect(atDepth1?.summary).toBe("Child");

		const atDepth2 = results.find((r) => r.depth === 2);
		expect(atDepth2?.memory_id).toBe(idC);
		expect(atDepth2?.summary).toBe("Grandchild");
	});

	test("traverse respects maxDepth", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "A");
		const idB = await storeMemory(app, key, "B");
		const idC = await storeMemory(app, key, "C");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});
		await mcpCallTool(app, key, "link", {
			source_id: idB,
			target_id: idC,
			edge_type: "related_to",
		});

		const data = await mcpCallTool(app, key, "traverse", {
			memory_id: idA,
			max_depth: 1,
		});

		const results = parseResult(data) as Array<{ depth: number }>;
		expect(results).toHaveLength(1);
		expect(results[0]?.depth).toBe(1);
	});

	test("traverse filters by edge types", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "A");
		const idB = await storeMemory(app, key, "B");
		const idC = await storeMemory(app, key, "C");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});
		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idC,
			edge_type: "contradicts",
		});

		const data = await mcpCallTool(app, key, "traverse", {
			memory_id: idA,
			edge_types: ["contradicts"],
		});

		const results = parseResult(data) as Array<{ memory_id: string }>;
		expect(results).toHaveLength(1);
		expect(results[0]?.memory_id).toBe(idC);
	});

	test("traverse hides other user's memories in results", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const adminToken = await getToken(app);
		const adminKey = await createApiKey(app);

		const user = await createRegularUser(app, adminToken);
		const userKey = await createApiKey(app, user.token);

		// User creates two memories and links them
		const userA = await storeMemory(app, userKey, "User A");
		const userB = await storeMemory(app, userKey, "User B");

		await mcpCallTool(app, userKey, "link", {
			source_id: userA,
			target_id: userB,
			edge_type: "related_to",
		});

		// Admin can't see user's graph
		const data = await mcpCallTool(app, adminKey, "traverse", { memory_id: userA });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Memory not found.");
	});

	// --- forget cascade ---

	test("forget cleans up graph edges", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const idA = await storeMemory(app, key, "Memory A");
		const idB = await storeMemory(app, key, "Memory B");

		await mcpCallTool(app, key, "link", {
			source_id: idA,
			target_id: idB,
			edge_type: "related_to",
		});

		// Verify edge exists
		const beforeData = await mcpCallTool(app, key, "related", { memory_id: idB });
		const neighborsBefore = parseResult(beforeData) as unknown[];
		expect(neighborsBefore).toHaveLength(1);

		// Delete memory A
		await mcpCallTool(app, key, "forget", { id: idA });

		// Edge should be gone (CASCADE + explicit cleanup)
		const afterData = await mcpCallTool(app, key, "related", { memory_id: idB });
		const neighborsAfter = parseResult(afterData) as unknown[];
		expect(neighborsAfter).toHaveLength(0);
	});

	// --- tools not registered when graph is disabled ---

	test("graph tools not available when graph is disabled", async () => {
		setGraphProvider(null);
		const app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);

		const data = await mcpCallTool(app, key, "link", {
			source_id: "a",
			target_id: "b",
			edge_type: "related_to",
		});

		// MCP SDK returns isError or a JSON-RPC error for unknown tools
		const isToolError = data.error !== undefined || data.result?.isError === true;
		expect(isToolError).toBe(true);
	});
});
