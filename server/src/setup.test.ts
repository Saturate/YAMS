import { describe, expect, test } from "bun:test";
import { createTestApp, setupAdmin } from "./test-helpers.js";

describe("setup", () => {
	test("returns 503 before setup on API routes", async () => {
		const app = createTestApp();
		const res = await app.request("/api/auth/login");
		expect(res.status).toBe(503);
	});

	test("health bypasses setup guard", async () => {
		const app = createTestApp();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; checks: Record<string, string> };
		expect(body.status).toBe("ok");
		expect(body.checks.database).toBe("ok");
		expect(body.checks.server).toBe("ok");
	});

	test("GET /setup passes through to SPA", async () => {
		const app = createTestApp();
		const res = await app.request("/setup");
		// Guard no longer blocks GET /setup — the SPA fallback serves index.html
		expect(res.status).toBe(200);
	});

	test("POST /setup creates admin user", async () => {
		const app = createTestApp();
		const res = await app.request("/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "password123" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; username: string };
		expect(body.username).toBe("admin");
		expect(body.id).toBeDefined();
	});

	test("rejects short username", async () => {
		const app = createTestApp();
		const res = await app.request("/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "ab", password: "password123" }),
		});
		expect(res.status).toBe(400);
	});

	test("rejects short password", async () => {
		const app = createTestApp();
		const res = await app.request("/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "short" }),
		});
		expect(res.status).toBe(400);
	});

	test("blocks re-setup after admin exists", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "another", password: "password123" }),
		});
		expect(res.status).toBe(403);
	});
});
