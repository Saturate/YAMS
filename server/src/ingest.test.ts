import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getMemory } from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import { setQdrantClient } from "./qdrant.js";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

const mockEmbed = mock(() => Promise.resolve(new Array(768).fill(0.1) as number[]));
const mockUpsert = mock(() => Promise.resolve({}));

const mockProvider: EmbeddingProvider = {
	name: "mock",
	dimensions: 768,
	embed: mockEmbed,
};

const mockQdrantClient = {
	getCollections: () => Promise.resolve({ collections: [{ name: "yams_memories" }] }),
	upsert: mockUpsert,
} as unknown as import("@qdrant/js-client-rest").QdrantClient;

async function createApiKey(app: ReturnType<typeof createTestApp>) {
	const token = await getToken(app);
	const res = await app.request("/api/keys", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: "ingest-test" }),
	});
	const body = (await res.json()) as { key: string };
	return body.key;
}

describe("POST /ingest", () => {
	beforeEach(() => {
		setProvider(mockProvider);
		setQdrantClient(mockQdrantClient);
		mockEmbed.mockClear();
		mockUpsert.mockClear();
	});

	afterEach(() => {
		setProvider(mockProvider);
		setQdrantClient(null);
	});

	test("ingests with valid key and body", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				summary: "Refactored auth middleware",
				git_remote: "github.com/org/repo",
				scope: "session",
			}),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			id: string;
			summary: string;
			scope: string;
			git_remote: string;
			created_at: string;
		};
		expect(body.id).toBeDefined();
		expect(body.summary).toBe("Refactored auth middleware");
		expect(body.scope).toBe("session");
		expect(body.git_remote).toBe("github.com/org/repo");
		expect(body.created_at).toBeDefined();

		// Verify stored in SQLite
		const memory = getMemory(body.id);
		expect(memory).toBeDefined();
		expect(memory?.summary).toBe("Refactored auth middleware");
	});

	test("rejects missing summary", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ git_remote: "github.com/org/repo" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Summary");
	});

	test("rejects missing auth", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ summary: "test" }),
		});

		expect(res.status).toBe(401);
	});

	test("rejects revoked key", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		// Create and revoke a key
		const createRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "to-revoke" }),
		});
		const { id, key } = (await createRes.json()) as { id: string; key: string };

		await app.request(`/api/keys/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ summary: "test" }),
		});

		expect(res.status).toBe(401);
	});

	test("defaults scope to session", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ summary: "no scope provided" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { scope: string };
		expect(body.scope).toBe("session");
	});

	test("stores metadata in SQLite", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				summary: "with metadata",
				metadata: { branch: "main", tool: "claude-code" },
			}),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		const memory = getMemory(body.id);
		expect(memory).toBeDefined();
		expect(memory?.metadata).toBeDefined();
		const parsed = JSON.parse(memory?.metadata ?? "{}") as Record<string, string>;
		expect(parsed.branch).toBe("main");
		expect(parsed.tool).toBe("claude-code");
	});

	test("calls embedding provider with summary text", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ summary: "embedding test" }),
		});

		expect(mockEmbed).toHaveBeenCalledWith("embedding test");
	});

	test("calls Qdrant upsert with correct payload", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				summary: "qdrant test",
				git_remote: "github.com/test/repo",
				scope: "project",
			}),
		});

		expect(res.status).toBe(201);
		expect(mockUpsert).toHaveBeenCalledTimes(1);

		const call = mockUpsert.mock.calls[0] as unknown[];
		expect(call[0]).toBe("yams_memories");
		const upsertData = call[1] as { points: Array<{ payload: Record<string, unknown> }> };
		const point = upsertData.points[0];
		expect(point).toBeDefined();
		expect(point?.payload.git_remote).toBe("github.com/test/repo");
		expect(point?.payload.scope).toBe("project");
		expect(point?.payload.api_key_label).toBe("ingest-test");
	});

	test("rejects invalid scope", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ summary: "bad scope", scope: "invalid" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("scope");
	});

	test("returns 502 when embedding provider fails", async () => {
		const failingProvider: EmbeddingProvider = {
			name: "failing",
			dimensions: 768,
			embed: () => Promise.reject(new Error("connection refused")),
		};
		setProvider(failingProvider);

		const app = createTestApp();
		await setupAdmin(app);
		const apiKey = await createApiKey(app);

		const res = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ summary: "will fail" }),
		});

		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Embedding provider");
	});
});
