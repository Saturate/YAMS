import { describe, expect, test } from "bun:test";
import { createTestApp, setupAdmin } from "./test-helpers.js";

describe("rate limiting", () => {
	test("blocks after exceeding max requests on /api/auth", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		// /api/auth rate limit: 10 req / 60s window
		const responses = [];
		for (let i = 0; i < 12; i++) {
			const res = await app.request("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "wrong" }),
			});
			responses.push(res.status);
		}

		// First 10 should be 401 (wrong password), then 429
		const rateLimited = responses.filter((s) => s === 429);
		expect(rateLimited.length).toBeGreaterThanOrEqual(1);
	});

	test("returns Retry-After header on 429", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		// Exhaust the rate limit on /api/auth
		for (let i = 0; i < 11; i++) {
			await app.request("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "wrong" }),
			});
		}

		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "wrong" }),
		});
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	test("rate limit resets between tests via createTestApp", async () => {
		// createTestApp calls resetRateLimiters, so this test should start fresh
		const app = createTestApp();
		await setupAdmin(app);

		// First login attempt should succeed, not be rate limited
		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "password123" }),
		});
		expect(res.status).toBe(200);
	});

	test("different rate limit buckets are independent", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		// Exhaust /api/auth limit (10 requests)
		for (let i = 0; i < 11; i++) {
			await app.request("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "wrong" }),
			});
		}

		// Verify /api/auth is blocked
		const blockedRes = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "wrong" }),
		});
		expect(blockedRes.status).toBe(429);

		// /health should still work (no rate limit)
		const healthRes = await app.request("/health");
		expect(healthRes.status).toBe(200);
	});
});
