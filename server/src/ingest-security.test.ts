import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getMemory } from "./db.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import type { StorageProvider } from "./storage.js";
import { setStorageProvider } from "./storage.js";
import { createRegularUser, createTestApp, getToken, setupAdmin } from "./test-helpers.js";

const mockEmbed = mock(() => Promise.resolve(new Array(768).fill(0.1) as number[]));
const mockUpsert = mock(() => Promise.resolve());

const mockProvider: EmbeddingProvider = {
	name: "mock",
	dimensions: 768,
	embed: mockEmbed,
};

const mockStorage: StorageProvider = {
	name: "mock",
	init: () => Promise.resolve(),
	upsert: mockUpsert,
	search: mock(() => Promise.resolve([])),
	delete: mock(() => Promise.resolve()),
	healthy: () => Promise.resolve(true),
};

async function createApiKey(app: ReturnType<typeof createTestApp>, token?: string) {
	const t = token ?? (await getToken(app));
	const res = await app.request("/api/keys", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${t}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: "sec-test" }),
	});
	return (await res.json()) as { key: string; id: string };
}

describe("Ingest security: cross-user replace", () => {
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		app = createTestApp();
		setProvider(mockProvider);
		setStorageProvider(mockStorage);
		mockEmbed.mockClear();
		mockUpsert.mockClear();
	});

	test("user B cannot replace user A's memory", async () => {
		await setupAdmin(app);
		const adminToken = await getToken(app);

		// User A = admin, create a memory
		const adminKey = await createApiKey(app, adminToken);
		const createRes = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${adminKey.key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ summary: "User A secret", scope: "global" }),
		});
		expect(createRes.status).toBe(201);
		const { id: memoryId } = (await createRes.json()) as { id: string };

		// Create user B
		const userB = await createRegularUser(app, adminToken, "userB", "password123");
		const userBKey = await createApiKey(app, userB.token);

		// User B tries to replace user A's memory
		const replaceRes = await app.request("/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${userBKey.key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				summary: "OVERWRITTEN by user B",
				replace: memoryId,
			}),
		});

		expect(replaceRes.status).toBe(400);
		const body = (await replaceRes.json()) as { error: string };
		expect(body.error).toContain("not found");

		// Verify original memory is unchanged
		const memory = getMemory(memoryId);
		expect(memory?.summary).toBe("User A secret");
	});
});
