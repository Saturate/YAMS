import { describe, expect, test } from "bun:test";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

describe("keys", () => {
	test("create a key", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		const res = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "test-key" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; key: string; label: string };
		expect(body.key).toStartWith("yams_");
		expect(body.label).toBe("test-key");
	});

	test("create key requires label", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		const res = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("list keys", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		// Create two keys
		await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "key-1" }),
		});
		await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "key-2" }),
		});

		const res = await app.request("/api/keys", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body).toHaveLength(2);
		// key_hash should never be exposed
		for (const k of body) {
			expect(k.key_hash).toBeUndefined();
		}
	});

	test("revoke a key", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		const createRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "to-revoke" }),
		});
		const { id, key } = (await createRes.json()) as { id: string; key: string };

		const revokeRes = await app.request(`/api/keys/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(revokeRes.status).toBe(200);
		const body = (await revokeRes.json()) as { revoked: boolean };
		expect(body.revoked).toBe(true);

		// Revoked key should be rejected on /api/keys/me
		const meRes = await app.request("/api/keys/me", {
			method: "GET",
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(meRes.status).toBe(401);
	});

	test("expired key is rejected", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		// Create a key that expires immediately (1 second, then wait)
		const createRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "short-lived", expires_in: -1 }),
		});

		// expires_in: -1 will create a key already expired
		const { key } = (await createRes.json()) as { key: string };

		const meRes = await app.request("/api/keys/me", {
			method: "GET",
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(meRes.status).toBe(401);
	});
});
