import { describe, expect, test } from "bun:test";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

describe("keys/me", () => {
	test("returns info about the calling key", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		const createRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "my-agent" }),
		});
		const { key } = (await createRes.json()) as { key: string };

		const meRes = await app.request("/api/keys/me", {
			method: "GET",
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(meRes.status).toBe(200);
		const body = (await meRes.json()) as { label: string; is_active: boolean };
		expect(body.label).toBe("my-agent");
		expect(body.is_active).toBe(true);
	});

	test("rejects missing auth", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/keys/me", { method: "GET" });
		expect(res.status).toBe(401);
	});

	test("rejects invalid key", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/keys/me", {
			method: "GET",
			headers: { Authorization: "Bearer yams_invalidkey123" },
		});
		expect(res.status).toBe(401);
	});

	test("rejects revoked key", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		const createRes = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "will-revoke" }),
		});
		const { id, key } = (await createRes.json()) as { id: string; key: string };

		await app.request(`/api/keys/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		const meRes = await app.request("/api/keys/me", {
			method: "GET",
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(meRes.status).toBe(401);
	});
});
