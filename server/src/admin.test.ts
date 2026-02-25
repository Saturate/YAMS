import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemory } from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import { setQdrantClient } from "./qdrant.js";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

const mockVector = new Array(768).fill(0.1) as number[];
const mockEmbed = mock(() => Promise.resolve(mockVector));
const mockDelete = mock(() => Promise.resolve({}));
const mockSearch = mock(() =>
	Promise.resolve([
		{
			id: "mem-1",
			version: 1,
			score: 0.9,
			payload: {
				memory_id: "mem-1",
				git_remote: "github.com/org/repo",
				scope: "session",
				api_key_label: "test",
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
	upsert: mock(() => Promise.resolve({})),
	search: mockSearch,
	delete: mockDelete,
} as unknown as import("@qdrant/js-client-rest").QdrantClient;

async function getAdminToken(app: ReturnType<typeof createTestApp>) {
	await setupAdmin(app);
	return getToken(app);
}

function seedMemory(id: string, apiKeyId: string, opts?: { gitRemote?: string; scope?: string }) {
	createMemory({
		id,
		apiKeyId,
		gitRemote: opts?.gitRemote ?? null,
		scope: opts?.scope ?? "session",
		summary: `Memory ${id}`,
	});
}

describe("admin API", () => {
	beforeEach(() => {
		setProvider(mockProvider);
		setQdrantClient(mockQdrantClient);
		mockEmbed.mockClear();
		mockSearch.mockClear();
		mockDelete.mockClear();
	});

	afterEach(() => {
		setProvider(mockProvider);
		setQdrantClient(null);
	});

	test("rejects unauthenticated requests", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/admin/stats", { method: "GET" });
		expect(res.status).toBe(401);
	});

	test("GET /stats returns counts", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		const res = await app.request("/api/admin/stats", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			memories: number;
			keys: { total: number; active: number };
			projects: number;
		};
		expect(body.memories).toBe(0);
		expect(body.keys.total).toBeGreaterThanOrEqual(0);
		expect(body.projects).toBe(0);
	});

	test("GET /filters returns empty when no memories", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		const res = await app.request("/api/admin/filters", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: string[]; scopes: string[] };
		expect(body.projects).toEqual([]);
		expect(body.scopes).toEqual([]);
	});

	test("POST /search requires query", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		const res = await app.request("/api/admin/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("POST /search returns results", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		// Seed a memory so enrichment works
		const keyRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "admin-test" }),
		});
		const { id: keyId } = (await keyRes.json()) as { id: string };
		seedMemory("mem-1", keyId, { gitRemote: "github.com/org/repo" });

		const res = await app.request("/api/admin/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "test search" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: Array<{ score: number; summary: string }> };
		expect(body.results).toHaveLength(1);
		expect(body.results[0]?.score).toBe(0.9);
		expect(mockEmbed).toHaveBeenCalledWith("test search");
	});

	test("GET /memories lists with pagination", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		// Seed memories
		const keyRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "admin-test" }),
		});
		const { id: keyId } = (await keyRes.json()) as { id: string };
		seedMemory("m1", keyId);
		seedMemory("m2", keyId);

		const res = await app.request("/api/admin/memories?limit=1&offset=0", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { memories: unknown[]; total: number };
		expect(body.memories).toHaveLength(1);
		expect(body.total).toBe(2);
	});

	test("DELETE /memories/:id deletes a memory", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		const keyRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "admin-test" }),
		});
		const { id: keyId } = (await keyRes.json()) as { id: string };
		seedMemory("del-1", keyId);

		const res = await app.request("/api/admin/memories/del-1", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; deleted: boolean };
		expect(body.deleted).toBe(true);
	});

	test("DELETE /memories/:id returns 404 for missing", async () => {
		const app = createTestApp();
		const token = await getAdminToken(app);

		const res = await app.request("/api/admin/memories/nonexistent", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	test("POST /search returns 502 when embedding fails", async () => {
		const failingProvider: EmbeddingProvider = {
			name: "failing",
			dimensions: 768,
			embed: () => Promise.reject(new Error("connection refused")),
		};
		setProvider(failingProvider);

		const app = createTestApp();
		const token = await getAdminToken(app);

		const res = await app.request("/api/admin/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "will fail" }),
		});
		expect(res.status).toBe(502);
	});
});
