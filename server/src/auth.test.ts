import { describe, expect, test } from "bun:test";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

describe("auth", () => {
	test("login succeeds with correct credentials", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "password123" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { username: string };
		expect(body.username).toBe("admin");
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("yams_session=");
	});

	test("login fails with wrong password", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "wrongpassword" }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Invalid credentials.");
	});

	test("login fails with unknown user", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "nobody", password: "password123" }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		// Same message as wrong password to prevent enumeration
		expect(body.error).toBe("Invalid credentials.");
	});

	test("JWT-protected route rejects missing token", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/keys", { method: "GET" });
		expect(res.status).toBe(401);
	});

	test("JWT-protected route rejects invalid token", async () => {
		const app = createTestApp();
		await setupAdmin(app);

		const res = await app.request("/api/keys", {
			method: "GET",
			headers: { Authorization: "Bearer not.a.valid.jwt" },
		});
		expect(res.status).toBe(401);
	});

	test("JWT-protected route accepts valid token", async () => {
		const app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);

		const res = await app.request("/api/keys", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
	});
});
