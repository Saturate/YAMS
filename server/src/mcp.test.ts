import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getMemory } from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import { setQdrantClient } from "./qdrant.js";
import { createRegularUser, createTestApp, getToken, setupAdmin } from "./test-helpers.js";

const mockVector = new Array(768).fill(0.1) as number[];
const mockEmbed = mock(() => Promise.resolve(mockVector));
const mockUpsert = mock(() => Promise.resolve({}));
const mockSearch = mock(() =>
	Promise.resolve([
		{
			id: "pt-1",
			version: 1,
			score: 0.95,
			payload: {
				memory_id: "mem-1",
				git_remote: "github.com/org/repo",
				scope: "session",
				api_key_label: "test-key",
				created_at: "2026-01-01T00:00:00.000Z",
			},
		},
	]),
);

const mockProvider: EmbeddingProvider = {
	name: "mock",
	dimensions: 768,
	embed: mockEmbed,
};

const mockQdrantClient = {
	getCollections: () => Promise.resolve({ collections: [{ name: "yams_memories" }] }),
	upsert: mockUpsert,
	search: mockSearch,
} as unknown as import("@qdrant/js-client-rest").QdrantClient;

async function createApiKey(app: ReturnType<typeof createTestApp>) {
	const token = await getToken(app);
	const res = await app.request("/api/keys", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: "mcp-test" }),
	});
	const body = (await res.json()) as { key: string };
	return body.key;
}

interface JsonRpcResponse {
	jsonrpc: string;
	id: number;
	result?: {
		content?: Array<{ type: string; text: string }>;
		isError?: boolean;
		protocolVersion?: string;
		serverInfo?: { name: string; version: string };
		capabilities?: Record<string, unknown>;
	};
	error?: { code: number; message: string };
}

const MCP_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
} as const;

async function mcpInitialize(
	app: ReturnType<typeof createTestApp>,
	apiKey: string,
): Promise<JsonRpcResponse> {
	const res = await app.request("/mcp", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...MCP_HEADERS,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "test-client", version: "1.0.0" },
			},
			id: 1,
		}),
	});
	return (await res.json()) as JsonRpcResponse;
}

async function mcpCallTool(
	app: ReturnType<typeof createTestApp>,
	apiKey: string,
	name: string,
	args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
	const res = await app.request("/mcp", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...MCP_HEADERS,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name, arguments: args },
			id: 2,
		}),
	});
	return (await res.json()) as JsonRpcResponse;
}

describe("MCP server", () => {
	beforeEach(() => {
		setProvider(mockProvider);
		setQdrantClient(mockQdrantClient);
		mockEmbed.mockClear();
		mockUpsert.mockClear();
		mockSearch.mockClear();
	});

	afterEach(() => {
		setProvider(mockProvider);
		setQdrantClient(null);
	});

	test("rejects missing auth", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0" },
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(401);
	});

	test("initializes successfully", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpInitialize(app, apiKey);
		expect(data.result?.serverInfo?.name).toBe("yams");
		expect(data.result?.protocolVersion).toBeDefined();
	});

	test("search tool returns results", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpCallTool(app, apiKey, "search", {
			query: "auth middleware",
			limit: 5,
		});

		expect(data.result?.isError).toBeUndefined();
		const text = data.result?.content?.[0]?.text;
		expect(text).toBeDefined();
		const memories = JSON.parse(text ?? "[]") as Array<{ score: number }>;
		expect(memories).toHaveLength(1);
		expect(memories[0]?.score).toBe(0.95);
		expect(mockEmbed).toHaveBeenCalledWith("auth middleware");
	});

	test("search tool passes filters", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		await mcpCallTool(app, apiKey, "search", {
			query: "test",
			scope: "project",
			project: "github.com/org/repo",
		});

		expect(mockSearch).toHaveBeenCalledTimes(1);
		const searchCall = mockSearch.mock.calls[0] as unknown[];
		expect(searchCall[0]).toBe("yams_memories");
		const searchParams = searchCall[1] as Record<string, unknown>;
		const filter = searchParams.filter as {
			must: Array<{ key: string; match: { value: string } }>;
		};
		expect(filter.must).toContainEqual({ key: "scope", match: { value: "project" } });
		expect(filter.must).toContainEqual({
			key: "git_remote",
			match: { value: "github.com/org/repo" },
		});
	});

	test("remember tool stores a memory", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpCallTool(app, apiKey, "remember", {
			content: "Always use strict TypeScript",
			scope: "global",
		});

		expect(data.result?.isError).toBeUndefined();
		const text = data.result?.content?.[0]?.text;
		expect(text).toBeDefined();
		const parsed = JSON.parse(text ?? "{}") as { stored: boolean; id: string; scope: string };
		expect(parsed.stored).toBe(true);
		expect(parsed.id).toBeDefined();
		expect(parsed.scope).toBe("global");

		// Verify in SQLite
		const memory = getMemory(parsed.id);
		expect(memory?.summary).toBe("Always use strict TypeScript");
	});

	test("remember tool stores with project", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpCallTool(app, apiKey, "remember", {
			content: "Use Hono for routing",
			scope: "project",
			project: "github.com/test/yams",
		});

		const text = data.result?.content?.[0]?.text;
		const parsed = JSON.parse(text ?? "{}") as { id: string; git_remote: string };
		expect(parsed.git_remote).toBe("github.com/test/yams");

		const memory = getMemory(parsed.id);
		expect(memory?.git_remote).toBe("github.com/test/yams");
	});

	test("list_projects returns distinct git remotes", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		// Store some memories with different projects
		await mcpCallTool(app, apiKey, "remember", {
			content: "memory 1",
			project: "github.com/org/repo-a",
		});
		await mcpCallTool(app, apiKey, "remember", {
			content: "memory 2",
			project: "github.com/org/repo-b",
		});
		await mcpCallTool(app, apiKey, "remember", {
			content: "memory 3",
			project: "github.com/org/repo-a",
		});

		const data = await mcpCallTool(app, apiKey, "list_projects", {});

		const text = data.result?.content?.[0]?.text;
		const parsed = JSON.parse(text ?? "{}") as { projects: string[] };
		expect(parsed.projects).toContain("github.com/org/repo-a");
		expect(parsed.projects).toContain("github.com/org/repo-b");
		expect(parsed.projects).toHaveLength(2);
	});

	test("list_projects returns empty when no memories", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpCallTool(app, apiKey, "list_projects", {});

		const text = data.result?.content?.[0]?.text;
		const parsed = JSON.parse(text ?? "{}") as { projects: string[] };
		expect(parsed.projects).toHaveLength(0);
	});

	test("search handles embedding failure gracefully", async () => {
		const failingProvider: EmbeddingProvider = {
			name: "failing",
			dimensions: 768,
			embed: () => Promise.reject(new Error("connection refused")),
		};
		setProvider(failingProvider);

		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpCallTool(app, apiKey, "search", { query: "test" });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toContain("Embedding service unavailable");
	});

	test("forget tool deletes own memory", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		// Store a memory first
		const storeData = await mcpCallTool(app, apiKey, "remember", {
			content: "delete me later",
			scope: "global",
		});
		const storeText = storeData.result?.content?.[0]?.text;
		const { id } = JSON.parse(storeText ?? "{}") as { id: string };
		expect(getMemory(id)).toBeDefined();

		// Delete it
		const data = await mcpCallTool(app, apiKey, "forget", { id });

		expect(data.result?.isError).toBeUndefined();
		const text = data.result?.content?.[0]?.text;
		const parsed = JSON.parse(text ?? "{}") as { id: string; deleted: boolean };
		expect(parsed.deleted).toBe(true);
		expect(getMemory(id)).toBeUndefined();
	});

	test("forget tool returns error for nonexistent memory", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const data = await mcpCallTool(app, apiKey, "forget", { id: "does-not-exist" });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Memory not found.");
	});

	test("forget tool prevents deleting another user's memory", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const adminToken = await getToken(app);
		const adminApiKey = await createApiKey(app);

		// Store a memory as admin
		const storeData = await mcpCallTool(app, adminApiKey, "remember", {
			content: "admin's secret memory",
			scope: "global",
		});
		const { id } = JSON.parse(storeData.result?.content?.[0]?.text ?? "{}") as { id: string };

		// Create a regular user and get their API key
		const user = await createRegularUser(app, adminToken);
		const userKeyRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${user.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "user-key" }),
		});
		const userApiKey = ((await userKeyRes.json()) as { key: string }).key;

		// Try to delete admin's memory as regular user
		const data = await mcpCallTool(app, userApiKey, "forget", { id });

		expect(data.result?.isError).toBe(true);
		expect(data.result?.content?.[0]?.text).toBe("Memory not found.");

		// Verify memory still exists
		expect(getMemory(id)).toBeDefined();
	});
});
