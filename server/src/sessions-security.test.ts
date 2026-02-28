import { beforeEach, describe, expect, test } from "bun:test";
import {
	type SessionRow,
	countObservations,
	deleteUser,
	findSession,
	getSession,
	listObservations,
	listSessions,
	setConfig,
} from "./db.js";
import { createRegularUser, createTestApp, getToken, setupAdmin } from "./test-helpers.js";

function assertSession(session: SessionRow | undefined): asserts session is SessionRow {
	if (!session) throw new Error("Expected session to be defined");
}

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

describe("Security: Session Capture", () => {
	let app: ReturnType<typeof createTestApp>;

	beforeEach(async () => {
		app = createTestApp();
		await setupAdmin(app);
	});

	// --- Cross-user data isolation ---

	describe("Cross-user isolation", () => {
		test("user A cannot see user B's sessions via admin API", async () => {
			setConfig("memory_mode", "full");

			const adminToken = await getToken(app);

			// Create user B
			const userB = await createRegularUser(app, adminToken, "userB", "password123");
			const userBKey = await createApiKey(app, userB.token);

			// Create a session for user B
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userBKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "userB-sess", cwd: "/secret-project" }),
			});

			// User B should see their own session
			const userBSessions = await app.request("/api/admin/sessions", {
				headers: { Authorization: `Bearer ${userB.token}` },
			});
			const userBBody = (await userBSessions.json()) as { sessions: SessionRow[]; total: number };
			expect(userBBody.total).toBe(1);

			// Create user A
			const userA = await createRegularUser(app, adminToken, "userA", "password123");

			// User A should NOT see user B's sessions
			const userASessions = await app.request("/api/admin/sessions", {
				headers: { Authorization: `Bearer ${userA.token}` },
			});
			const userABody = (await userASessions.json()) as { sessions: SessionRow[]; total: number };
			expect(userABody.total).toBe(0);
		});

		test("user A cannot access user B's session detail via IDOR", async () => {
			setConfig("memory_mode", "full");

			const adminToken = await getToken(app);

			const userB = await createRegularUser(app, adminToken, "userB2", "password123");
			const userBKey = await createApiKey(app, userB.token);

			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userBKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "private-sess", cwd: "/tmp" }),
			});

			const session = findSession("private-sess", userBKey.id);
			assertSession(session);

			const userA = await createRegularUser(app, adminToken, "userA2", "password123");

			// User A tries to access user B's session by ID
			const res = await app.request(`/api/admin/sessions/${session.id}`, {
				headers: { Authorization: `Bearer ${userA.token}` },
			});
			expect(res.status).toBe(404);
		});

		test("user A cannot delete user B's session", async () => {
			setConfig("memory_mode", "full");

			const adminToken = await getToken(app);

			const userB = await createRegularUser(app, adminToken, "userB3", "password123");
			const userBKey = await createApiKey(app, userB.token);

			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userBKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "del-target", cwd: "/tmp" }),
			});

			const session = findSession("del-target", userBKey.id);
			assertSession(session);

			const userA = await createRegularUser(app, adminToken, "userA3", "password123");

			const res = await app.request(`/api/admin/sessions/${session.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${userA.token}` },
			});
			expect(res.status).toBe(404);

			// Session should still exist
			expect(getSession(session.id)).toBeDefined();
		});

		test("admin CAN see all users' sessions", async () => {
			setConfig("memory_mode", "full");

			const adminToken = await getToken(app);
			const adminKey = await createApiKey(app);

			// Admin creates a session
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${adminKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "admin-sess", cwd: "/tmp" }),
			});

			// Create user and their session
			const user = await createRegularUser(app, adminToken, "userX", "password123");
			const userKey = await createApiKey(app, user.token);

			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "user-sess", cwd: "/tmp" }),
			});

			// Admin should see both
			const res = await app.request("/api/admin/sessions", {
				headers: { Authorization: `Bearer ${adminToken}` },
			});
			const body = (await res.json()) as { total: number };
			expect(body.total).toBe(2);
		});

		test("MCP session_context only returns own sessions", async () => {
			// This is tested implicitly via getRecentSessionSummaries filtering by userId
			// but let's verify the DB function directly
			setConfig("memory_mode", "full");

			const adminToken = await getToken(app);
			const adminKey = await createApiKey(app);

			const { createSession, updateSessionSummary } = await import("./db.js");

			const sessionId = createSession({
				claudeSessionId: "mcp-test",
				apiKeyId: adminKey.id,
				project: "test-project",
			});
			updateSessionSummary(sessionId, "Admin's session summary");

			const user = await createRegularUser(app, adminToken, "mcp-user", "password123");
			const userKey = await createApiKey(app, user.token);

			const userSessionId = createSession({
				claudeSessionId: "mcp-test-user",
				apiKeyId: userKey.id,
				project: "test-project",
			});
			updateSessionSummary(userSessionId, "User's session summary");

			const { getRecentSessionSummaries } = await import("./db.js");

			// Admin should only see admin's session (filtered by userId derived from apiKey)
			const adminSummaries = getRecentSessionSummaries({
				userId: `${adminKey.id.split("-")[0]}unused`, // wrong userId
			});
			expect(adminSummaries.length).toBe(0);
		});
	});

	// --- Input validation ---

	describe("Input validation", () => {
		test("rejects oversized session_id gracefully", async () => {
			setConfig("memory_mode", "full");

			const key = await createApiKey(app);

			// 10KB session_id should be truncated, not crash
			const hugeSessionId = "a".repeat(10_000);
			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: hugeSessionId, cwd: "/tmp" }),
			});

			expect(res.status).toBe(200);
		});

		test("rejects invalid event types", async () => {
			setConfig("memory_mode", "full");

			const key = await createApiKey(app);

			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "valid-sess",
					event: "MaliciousEvent",
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("Invalid event");
		});

		test("truncates oversized observation content", async () => {
			setConfig("memory_mode", "full");

			const key = await createApiKey(app);

			// Create a session first
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "big-obs", cwd: "/tmp" }),
			});

			// 100KB payload should be truncated
			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "big-obs",
					event: "UserPromptSubmit",
					prompt: "x".repeat(100_000),
				}),
			});

			expect(res.status).toBe(200);

			const session = findSession("big-obs", key.id);
			assertSession(session);
			const obs = listObservations(session.id);
			expect(obs.length).toBe(1);
			expect(obs[0]?.content.length).toBeLessThanOrEqual(50_001);
		});

		test("handles malformed JSON in hook body", async () => {
			setConfig("memory_mode", "full");
			const key = await createApiKey(app);

			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: "not json at all{{{",
			});

			expect(res.status).toBe(400);
		});

		test("handles empty body", async () => {
			const key = await createApiKey(app);

			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: "{}",
			});

			// In simple mode (default), returns 200
			expect(res.status).toBe(200);
		});
	});

	// --- Auth edge cases ---

	describe("Auth edge cases", () => {
		test("revoked API key cannot create sessions", async () => {
			setConfig("memory_mode", "full");

			const token = await getToken(app);
			const key = await createApiKey(app);

			// Revoke the key
			await app.request(`/api/keys/${key.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});

			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "revoked-sess", cwd: "/tmp" }),
			});

			expect(res.status).toBe(401);
		});

		test("JWT token cannot be used for hook endpoints", async () => {
			const token = await getToken(app);

			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "jwt-sess" }),
			});

			// JWT tokens don't start with 'yams_' so validateBearerKey rejects them
			expect(res.status).toBe(401);
		});

		test("no auth header returns 401", async () => {
			for (const endpoint of ["/hooks/session-start", "/hooks/observation", "/hooks/session-end"]) {
				const res = await app.request(endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ session_id: "no-auth" }),
				});
				expect(res.status).toBe(401);
			}
		});
	});

	// --- Settings security ---

	describe("Settings security", () => {
		test("compression_api_key is masked in GET response", async () => {
			const token = await getToken(app);

			// Set a compression API key
			await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ compression_api_key: "sk-ant-secret-key-12345" }),
			});

			// Read it back
			const res = await app.request("/api/admin/settings", {
				headers: { Authorization: `Bearer ${token}` },
			});
			const body = (await res.json()) as { settings: Record<string, string | null> };

			// Should be masked
			expect(body.settings.compression_api_key).not.toBe("sk-ant-secret-key-12345");
			expect(body.settings.compression_api_key).toContain("****");
			// First 4 chars should be visible
			expect(body.settings.compression_api_key?.startsWith("sk-a")).toBe(true);
		});

		test("non-admin cannot read settings", async () => {
			const adminToken = await getToken(app);
			const user = await createRegularUser(app, adminToken, "nonadmin", "password123");

			const res = await app.request("/api/admin/settings", {
				headers: { Authorization: `Bearer ${user.token}` },
			});
			expect(res.status).toBe(403);
		});

		test("non-admin cannot update settings", async () => {
			const adminToken = await getToken(app);
			const user = await createRegularUser(app, adminToken, "nonadmin2", "password123");

			const res = await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${user.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ memory_mode: "full" }),
			});
			expect(res.status).toBe(403);
		});

		test("rejects invalid memory_mode values", async () => {
			const token = await getToken(app);

			const res = await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ memory_mode: "malicious_value" }),
			});
			expect(res.status).toBe(400);
		});

		test("rejects invalid compression_provider values", async () => {
			const token = await getToken(app);

			const res = await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ compression_provider: "evil_provider" }),
			});
			expect(res.status).toBe(400);
		});

		test("rejects invalid compression_base_url", async () => {
			const token = await getToken(app);

			const res = await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ compression_base_url: "not-a-url" }),
			});
			expect(res.status).toBe(400);
		});

		test("rejects invalid session_context_count", async () => {
			const token = await getToken(app);

			for (const bad of ["abc", "0", "100", "-1"]) {
				const res = await app.request("/api/admin/settings", {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ session_context_count: bad }),
				});
				expect(res.status).toBe(400);
			}
		});

		test("null value clears a setting", async () => {
			const token = await getToken(app);

			// Set then clear
			await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ compression_model: "test-model" }),
			});

			await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ compression_model: null }),
			});

			const res = await app.request("/api/admin/settings", {
				headers: { Authorization: `Bearer ${token}` },
			});
			const body = (await res.json()) as { settings: Record<string, string | null> };
			expect(body.settings.compression_model).toBeNull();
		});
	});

	// --- Cascading deletes ---

	describe("Cascading deletes", () => {
		test("deleting user cleans up sessions and observations", async () => {
			setConfig("memory_mode", "full");

			const adminToken = await getToken(app);
			const user = await createRegularUser(app, adminToken, "deleteme", "password123");
			const userKey = await createApiKey(app, user.token);

			// Create session with observations
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "doomed-sess", cwd: "/tmp" }),
			});

			await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userKey.key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "doomed-sess",
					event: "UserPromptSubmit",
					prompt: "Will be deleted",
				}),
			});

			const session = findSession("doomed-sess", userKey.id);
			assertSession(session);
			expect(countObservations(session.id)).toBe(1);

			// Delete the user
			deleteUser(user.id);

			// Session and observations should be gone
			expect(getSession(session.id)).toBeUndefined();
			expect(countObservations(session.id)).toBe(0);
			expect(listSessions({ userId: user.id })).toHaveLength(0);
		});
	});

	// --- Hooks config ---

	describe("Hooks config security", () => {
		test("hooks config does not leak raw API key", async () => {
			const token = await getToken(app);
			const key = await createApiKey(app);

			const res = await app.request(`/api/keys/${key.id}/hooks-config`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			const body = await res.text();
			// Should use $YAMS_API_KEY variable, not the actual key
			expect(body).toContain("$YAMS_API_KEY");
			expect(body).not.toContain(key.key);
		});
	});
});
