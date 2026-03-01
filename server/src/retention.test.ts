import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	countMemories,
	createApiKey,
	createMemory,
	createUser,
	getExpiredMemoryIds,
	getMemory,
	getMemoryForUser,
	listMemories,
	setConfig,
} from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import { resolveExpiresAt, storeMemory } from "./ingest.js";
import { setQdrantClient } from "./qdrant.js";
import { sweepExpiredMemories } from "./retention.js";
import { createTestApp } from "./test-helpers.js";

const mockVector = new Array(768).fill(0.1) as number[];
const mockEmbed = mock(() => Promise.resolve(mockVector));
const mockUpsert = mock(() => Promise.resolve({}));
const mockDelete = mock(() => Promise.resolve({}));
const mockSearch = mock(() => Promise.resolve([] as unknown[]));

const mockProvider: EmbeddingProvider = {
	name: "mock",
	dimensions: 768,
	embed: mockEmbed,
};

const mockQdrantClient = {
	getCollections: () => Promise.resolve({ collections: [{ name: "yams_memories" }] }),
	upsert: mockUpsert,
	search: mockSearch,
	delete: mockDelete,
} as unknown as import("@qdrant/js-client-rest").QdrantClient;

function setupTestDb() {
	createTestApp();
	setProvider(mockProvider);
	setQdrantClient(mockQdrantClient);
}

function createTestUser(): { userId: string; apiKeyId: string } {
	const userId = createUser("testuser", "hash123", { role: "admin" });
	const apiKeyId = createApiKey({
		userId,
		label: "test",
		keyHash: `hash-${crypto.randomUUID()}`,
		keyPrefix: "ym_test",
		expiresAt: null,
	});
	return { userId, apiKeyId };
}

function expectExpiresNear(result: string | null, expectedSeconds: number): void {
	if (result === null) throw new Error("expected non-null expires_at");
	const actual = new Date(result).getTime();
	const expected = Date.now() + expectedSeconds * 1000;
	expect(Math.abs(actual - expected)).toBeLessThan(5000);
}

describe("resolveExpiresAt", () => {
	beforeEach(() => {
		setupTestDb();
	});

	test("session scope defaults to 30 days", () => {
		const result = resolveExpiresAt(undefined, "session");
		expectExpiresNear(result, 30 * 24 * 60 * 60);
	});

	test("project scope defaults to 90 days", () => {
		const result = resolveExpiresAt(undefined, "project");
		expectExpiresNear(result, 90 * 24 * 60 * 60);
	});

	test("global scope defaults to forever", () => {
		expect(resolveExpiresAt(undefined, "global")).toBeNull();
	});

	test("explicit ttl overrides scope default", () => {
		expectExpiresNear(resolveExpiresAt(3600, "global"), 3600);
	});

	test("explicit null means forever regardless of scope", () => {
		expect(resolveExpiresAt(null, "session")).toBeNull();
	});

	test("ttl_max caps scope defaults", () => {
		setConfig("ttl_max", "86400");
		expectExpiresNear(resolveExpiresAt(undefined, "session"), 86400);
	});

	test("ttl_max caps explicit forever to max", () => {
		setConfig("ttl_max", "86400");
		expectExpiresNear(resolveExpiresAt(null, "global"), 86400);
	});

	test("ttl_max caps explicit ttl", () => {
		setConfig("ttl_max", "3600");
		expectExpiresNear(resolveExpiresAt(86400, "session"), 3600);
	});

	test("custom scope default from config", () => {
		setConfig("ttl_default_session", "7200");
		expectExpiresNear(resolveExpiresAt(undefined, "session"), 7200);
	});

	test("0 means use scope default", () => {
		expectExpiresNear(resolveExpiresAt(0, "session"), 30 * 24 * 60 * 60);
	});
});

describe("expired memory filtering", () => {
	beforeEach(() => {
		setupTestDb();
	});

	test("getMemory excludes expired memories", () => {
		const { apiKeyId } = createTestUser();
		const id = crypto.randomUUID();
		createMemory({
			id,
			apiKeyId,
			scope: "session",
			summary: "expired memory",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		expect(getMemory(id)).toBeUndefined();
	});

	test("getMemory returns non-expired memories", () => {
		const { apiKeyId } = createTestUser();
		const id = crypto.randomUUID();
		createMemory({
			id,
			apiKeyId,
			scope: "session",
			summary: "valid memory",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(getMemory(id)).toBeDefined();
	});

	test("getMemory returns memories with no expiry", () => {
		const { apiKeyId } = createTestUser();
		const id = crypto.randomUUID();
		createMemory({
			id,
			apiKeyId,
			scope: "global",
			summary: "forever memory",
		});
		expect(getMemory(id)).toBeDefined();
	});

	test("getMemoryForUser excludes expired memories", () => {
		const { userId, apiKeyId } = createTestUser();
		const id = crypto.randomUUID();
		createMemory({
			id,
			apiKeyId,
			scope: "session",
			summary: "expired",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		expect(getMemoryForUser(id, userId)).toBeUndefined();
	});

	test("listMemories excludes expired", () => {
		const { apiKeyId } = createTestUser();
		createMemory({
			id: crypto.randomUUID(),
			apiKeyId,
			scope: "session",
			summary: "expired",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		createMemory({
			id: crypto.randomUUID(),
			apiKeyId,
			scope: "session",
			summary: "valid",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		const memories = listMemories();
		expect(memories).toHaveLength(1);
		expect(memories[0]?.summary).toBe("valid");
	});

	test("countMemories excludes expired", () => {
		const { apiKeyId } = createTestUser();
		createMemory({
			id: crypto.randomUUID(),
			apiKeyId,
			scope: "session",
			summary: "expired",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		createMemory({
			id: crypto.randomUUID(),
			apiKeyId,
			scope: "session",
			summary: "valid",
		});
		expect(countMemories()).toBe(1);
	});
});

describe("getExpiredMemoryIds", () => {
	beforeEach(() => {
		setupTestDb();
	});

	test("returns expired memory IDs", () => {
		const { apiKeyId } = createTestUser();
		const expiredId = crypto.randomUUID();
		createMemory({
			id: expiredId,
			apiKeyId,
			scope: "session",
			summary: "expired",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		createMemory({
			id: crypto.randomUUID(),
			apiKeyId,
			scope: "session",
			summary: "not expired",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		const ids = getExpiredMemoryIds(100);
		expect(ids).toEqual([expiredId]);
	});

	test("respects limit", () => {
		const { apiKeyId } = createTestUser();
		for (let i = 0; i < 5; i++) {
			createMemory({
				id: crypto.randomUUID(),
				apiKeyId,
				scope: "session",
				summary: `expired ${i}`,
				expiresAt: "2020-01-01T00:00:00.000Z",
			});
		}
		expect(getExpiredMemoryIds(3)).toHaveLength(3);
	});

	test("skips null expires_at", () => {
		const { apiKeyId } = createTestUser();
		createMemory({
			id: crypto.randomUUID(),
			apiKeyId,
			scope: "global",
			summary: "forever",
		});
		expect(getExpiredMemoryIds(100)).toHaveLength(0);
	});
});

describe("sweepExpiredMemories", () => {
	beforeEach(() => {
		setupTestDb();
		mockDelete.mockClear();
	});

	test("deletes expired memories from SQLite and Qdrant", async () => {
		const { apiKeyId } = createTestUser();
		const id1 = crypto.randomUUID();
		const id2 = crypto.randomUUID();
		createMemory({
			id: id1,
			apiKeyId,
			scope: "session",
			summary: "expired 1",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		createMemory({
			id: id2,
			apiKeyId,
			scope: "session",
			summary: "expired 2",
			expiresAt: "2020-06-01T00:00:00.000Z",
		});

		const count = await sweepExpiredMemories();
		expect(count).toBe(2);
		expect(mockDelete).toHaveBeenCalledTimes(2);
		expect(getExpiredMemoryIds(100)).toHaveLength(0);
	});

	test("returns 0 when nothing to sweep", async () => {
		createTestUser();
		const count = await sweepExpiredMemories();
		expect(count).toBe(0);
		expect(mockDelete).not.toHaveBeenCalled();
	});
});

describe("storeMemory with TTL", () => {
	beforeEach(() => {
		setupTestDb();
		mockEmbed.mockClear();
		mockUpsert.mockClear();
		mockSearch.mockReset();
		mockSearch.mockImplementation(() => Promise.resolve([] as unknown[]));
	});

	test("stores memory with scope-default expiry", async () => {
		const { userId, apiKeyId } = createTestUser();
		const result = await storeMemory({
			summary: "test session memory",
			apiKeyId,
			apiKeyLabel: "test",
			userId,
			scope: "session",
		});

		expect("expires_at" in result).toBe(true);
		if ("expires_at" in result) {
			expect(result.expires_at).not.toBeNull();
		}
	});

	test("stores global memory with no expiry by default", async () => {
		const { userId, apiKeyId } = createTestUser();
		const result = await storeMemory({
			summary: "test global memory",
			apiKeyId,
			apiKeyLabel: "test",
			userId,
			scope: "global",
		});

		if ("expires_at" in result) {
			expect(result.expires_at).toBeNull();
		}
	});

	test("explicit ttl=null overrides scope default to forever", async () => {
		const { userId, apiKeyId } = createTestUser();
		const result = await storeMemory({
			summary: "forever session memory",
			apiKeyId,
			apiKeyLabel: "test",
			userId,
			scope: "session",
			ttl: null,
		});

		if ("expires_at" in result) {
			expect(result.expires_at).toBeNull();
		}
	});

	test("passes expires_at to Qdrant payload", async () => {
		const { userId, apiKeyId } = createTestUser();
		await storeMemory({
			summary: "test memory",
			apiKeyId,
			apiKeyLabel: "test",
			userId,
			scope: "session",
			ttl: 3600,
		});

		expect(mockUpsert).toHaveBeenCalledTimes(1);
		const call = mockUpsert.mock.calls[0] as unknown[];
		const arg = call[1] as { points: Array<{ payload: Record<string, unknown> }> };
		expect(arg.points[0]?.payload.expires_at).not.toBeNull();
	});
});
