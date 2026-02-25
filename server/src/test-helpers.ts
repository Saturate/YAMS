import { app } from "./app.js";
import { initDb } from "./db.js";
import { resetRateLimiters } from "./rate-limit.js";

export function createTestApp() {
	initDb(":memory:");
	resetRateLimiters();
	return app;
}

export async function setupAdmin(
	testApp: typeof app,
	username = "admin",
	password = "password123",
) {
	const res = await testApp.request("/setup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	return (await res.json()) as { id: string; username: string };
}

export async function getToken(testApp: typeof app, username = "admin", password = "password123") {
	const res = await testApp.request("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	// Extract JWT from the httpOnly cookie
	const setCookie = res.headers.get("set-cookie") ?? "";
	const match = setCookie.match(/yams_session=([^;]+)/);
	if (!match) throw new Error("No session cookie in login response");
	return match[1];
}
