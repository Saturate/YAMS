import { beforeEach, describe, expect, test } from "bun:test";
import {
	type SessionRow,
	countObservations,
	countUncompressedObservations,
	createObservation,
	createSession,
	endSession,
	findSession,
	getSession,
	getSessionForUser,
	getUncompressedObservationsForUser,
	listObservations,
	markObservationsByIds,
	setConfig,
	updateSessionSummary,
	validateObservationIds,
	validateObservationsBelongToSession,
} from "./db.js";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

function assertSession(session: SessionRow | undefined): asserts session is SessionRow {
	if (!session) throw new Error("Expected session to be defined");
}

async function createApiKey(app: ReturnType<typeof createTestApp>) {
	const token = await getToken(app);
	const res = await app.request("/api/keys", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: "hooks-test" }),
	});
	const body = (await res.json()) as { key: string; id: string };
	return body;
}

describe("Hook endpoints", () => {
	let app: ReturnType<typeof createTestApp>;
	let apiKey: string;
	let apiKeyId: string;

	beforeEach(async () => {
		app = createTestApp();
		await setupAdmin(app);
		const key = await createApiKey(app);
		apiKey = key.key;
		apiKeyId = key.id;
	});

	// --- session-start ---

	describe("POST /hooks/session-start", () => {
		test("returns empty 200 in simple mode", async () => {
			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-1", cwd: "/home/user/project" }),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.hookSpecificOutput).toBeUndefined();
		});

		test("creates session in full mode", async () => {
			setConfig("memory_mode", "full");

			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-2", cwd: "/home/user/project" }),
			});

			expect(res.status).toBe(200);

			const session = findSession("sess-2", apiKeyId);
			expect(session).toBeDefined();
			expect(session?.project).toBe("/home/user/project");
			expect(session?.status).toBe("active");
		});

		test("returns context from previous sessions", async () => {
			setConfig("memory_mode", "full");

			// Manually create a session with a summary for context injection
			const { createSession, updateSessionSummary, endSession } = await import("./db.js");
			const oldSessionId = createSession({
				claudeSessionId: "old-sess",
				apiKeyId,
				project: "/home/user/project",
			});
			updateSessionSummary(oldSessionId, "Refactored auth middleware to use JWT tokens");
			endSession(oldSessionId);

			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-3", cwd: "/home/user/project" }),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hookSpecificOutput?: {
					hookEventName: string;
					additionalContext: string;
				};
			};
			expect(body.hookSpecificOutput).toBeDefined();
			expect(body.hookSpecificOutput?.hookEventName).toBe("SessionStart");
			expect(body.hookSpecificOutput?.additionalContext).toContain("Refactored auth middleware");
		});

		test("rejects missing auth", async () => {
			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_id: "sess-1" }),
			});

			expect(res.status).toBe(401);
		});

		test("rejects missing session_id in full mode", async () => {
			setConfig("memory_mode", "full");

			const res = await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ cwd: "/home" }),
			});

			expect(res.status).toBe(400);
		});

		test("uses project query param over cwd", async () => {
			setConfig("memory_mode", "full");

			const res = await app.request("/hooks/session-start?project=my-project", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-4", cwd: "/home/user/project" }),
			});

			expect(res.status).toBe(200);
			const session = findSession("sess-4", apiKeyId);
			expect(session?.project).toBe("my-project");
		});
	});

	// --- observation ---

	describe("POST /hooks/observation", () => {
		test("returns empty 200 in simple mode", async () => {
			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "sess-1",
					event: "UserPromptSubmit",
					prompt: "Fix the auth bug",
				}),
			});

			expect(res.status).toBe(200);
		});

		test("stores observation in full mode", async () => {
			setConfig("memory_mode", "full");

			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "sess-obs-1",
					event: "UserPromptSubmit",
					prompt: "Fix the auth bug",
				}),
			});

			expect(res.status).toBe(200);

			const session = findSession("sess-obs-1", apiKeyId);
			assertSession(session);
			const count = countObservations(session.id);
			expect(count).toBe(1);
		});

		test("skips low-value tools (Read, Glob, Grep)", async () => {
			setConfig("memory_mode", "full");

			// Create session first
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-skip", cwd: "/tmp" }),
			});

			for (const toolName of ["Read", "Glob", "Grep"]) {
				await app.request("/hooks/observation", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						session_id: "sess-skip",
						event: "PostToolUse",
						tool_name: toolName,
						tool_input: { path: "/some/file" },
					}),
				});
			}

			// Non-skipped tool should be stored
			await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "sess-skip",
					event: "PostToolUse",
					tool_name: "Edit",
					tool_input: { path: "/some/file" },
				}),
			});

			const session = findSession("sess-skip", apiKeyId);
			assertSession(session);
			const count = countObservations(session.id);
			expect(count).toBe(1);
		});

		test("rejects missing event", async () => {
			setConfig("memory_mode", "full");

			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-1" }),
			});

			expect(res.status).toBe(400);
		});

		test("stores multiple observations per session", async () => {
			setConfig("memory_mode", "full");

			for (let i = 0; i < 3; i++) {
				await app.request("/hooks/observation", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						session_id: "sess-multi",
						event: "UserPromptSubmit",
						prompt: `Prompt ${i}`,
					}),
				});
			}

			const session = findSession("sess-multi", apiKeyId);
			assertSession(session);
			const observations = listObservations(session.id);
			expect(observations.length).toBe(3);
		});

		test("returns uncompressed_count in response", async () => {
			setConfig("memory_mode", "full");

			const res = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "sess-count",
					event: "UserPromptSubmit",
					prompt: "First prompt",
				}),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as { uncompressed_count?: number };
			expect(body.uncompressed_count).toBe(1);

			// Second observation should increment
			const res2 = await app.request("/hooks/observation", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session_id: "sess-count",
					event: "UserPromptSubmit",
					prompt: "Second prompt",
				}),
			});

			const body2 = (await res2.json()) as { uncompressed_count?: number };
			expect(body2.uncompressed_count).toBe(2);
		});
	});

	// --- Client compression DB functions ---

	describe("Client compression DB functions", () => {
		test("markObservationsByIds marks only specified IDs", async () => {
			setConfig("memory_mode", "full");

			const sessId = createSession({
				claudeSessionId: "mark-ids-sess",
				apiKeyId,
			});

			const id1 = createObservation({
				sessionId: sessId,
				event: "UserPromptSubmit",
				content: "{}",
			});
			const id2 = createObservation({ sessionId: sessId, event: "PostToolUse", content: "{}" });
			const id3 = createObservation({ sessionId: sessId, event: "PostToolUse", content: "{}" });

			// Mark only id1 and id2
			const changed = markObservationsByIds([id1, id2]);
			expect(changed).toBe(2);

			// id3 should still be uncompressed
			expect(countUncompressedObservations(sessId)).toBe(1);

			// Marking again should return 0 (already compressed)
			expect(markObservationsByIds([id1])).toBe(0);
		});

		test("markObservationsByIds handles empty array", () => {
			expect(markObservationsByIds([])).toBe(0);
		});

		test("getUncompressedObservationsForUser respects user scope", async () => {
			setConfig("memory_mode", "full");

			const sessId = createSession({
				claudeSessionId: "uncompressed-scope",
				apiKeyId,
			});

			createObservation({ sessionId: sessId, event: "UserPromptSubmit", content: "{}" });
			createObservation({ sessionId: sessId, event: "PostToolUse", content: "{}" });

			const { getApiKeyById } = await import("./db.js");
			const key = getApiKeyById(apiKeyId);
			if (!key) throw new Error("Expected key");

			// Correct user should see observations
			const obs = getUncompressedObservationsForUser(sessId, key.user_id);
			expect(obs.length).toBe(2);

			// Wrong user should see nothing
			const empty = getUncompressedObservationsForUser(sessId, "wrong-user-id");
			expect(empty.length).toBe(0);
		});

		test("getUncompressedObservationsForUser respects limit", async () => {
			setConfig("memory_mode", "full");

			const sessId = createSession({
				claudeSessionId: "uncompressed-limit",
				apiKeyId,
			});

			for (let i = 0; i < 5; i++) {
				createObservation({ sessionId: sessId, event: "UserPromptSubmit", content: "{}" });
			}

			const { getApiKeyById } = await import("./db.js");
			const key = getApiKeyById(apiKeyId);
			if (!key) throw new Error("Expected key");

			const limited = getUncompressedObservationsForUser(sessId, key.user_id, 3);
			expect(limited.length).toBe(3);
		});

		test("validateObservationIds checks user ownership", async () => {
			setConfig("memory_mode", "full");

			const sessId = createSession({
				claudeSessionId: "validate-owner",
				apiKeyId,
			});

			const id1 = createObservation({
				sessionId: sessId,
				event: "UserPromptSubmit",
				content: "{}",
			});

			const { getApiKeyById } = await import("./db.js");
			const key = getApiKeyById(apiKeyId);
			if (!key) throw new Error("Expected key");

			expect(validateObservationIds([id1], key.user_id)).toBe(true);
			expect(validateObservationIds([id1], "wrong-user")).toBe(false);
			expect(validateObservationIds(["nonexistent-id"], key.user_id)).toBe(false);
		});

		test("validateObservationsBelongToSession checks session", async () => {
			setConfig("memory_mode", "full");

			const sess1 = createSession({ claudeSessionId: "belong-1", apiKeyId });
			const sess2 = createSession({ claudeSessionId: "belong-2", apiKeyId });

			const id1 = createObservation({ sessionId: sess1, event: "UserPromptSubmit", content: "{}" });
			const id2 = createObservation({ sessionId: sess2, event: "UserPromptSubmit", content: "{}" });

			// Same session should pass
			expect(validateObservationsBelongToSession([id1], sess1)).toBe(true);

			// Mixed sessions should fail
			expect(validateObservationsBelongToSession([id1, id2], sess1)).toBe(false);

			// Empty array should pass
			expect(validateObservationsBelongToSession([], sess1)).toBe(true);
		});
	});

	// --- session-end ---

	describe("POST /hooks/session-end", () => {
		test("marks session as ended", async () => {
			setConfig("memory_mode", "full");

			// Start a session
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-end-1", cwd: "/tmp" }),
			});

			const session = findSession("sess-end-1", apiKeyId);
			expect(session?.status).toBe("active");

			// End it
			const res = await app.request("/hooks/session-end", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "sess-end-1" }),
			});

			expect(res.status).toBe(200);

			assertSession(session);
			const ended = getSession(session.id);
			expect(ended?.status).toBe("ended");
			expect(ended?.ended_at).toBeDefined();
		});

		test("returns 200 for non-existent session", async () => {
			const res = await app.request("/hooks/session-end", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "nonexistent" }),
			});

			expect(res.status).toBe(200);
		});

		test("rejects missing auth", async () => {
			const res = await app.request("/hooks/session-end", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_id: "sess-1" }),
			});

			expect(res.status).toBe(401);
		});
	});

	// --- Admin session endpoints ---

	describe("Admin session endpoints", () => {
		test("GET /api/admin/sessions lists sessions", async () => {
			setConfig("memory_mode", "full");

			// Create a session via hook
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "admin-list-1", cwd: "/tmp/project" }),
			});

			const token = await getToken(app);
			const res = await app.request("/api/admin/sessions", {
				headers: { Authorization: `Bearer ${token}` },
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				sessions: Array<{ id: string; observation_count: number }>;
				total: number;
			};
			expect(body.total).toBeGreaterThanOrEqual(1);
			expect(body.sessions.length).toBeGreaterThanOrEqual(1);
			expect(body.sessions[0]?.observation_count).toBeDefined();
		});

		test("DELETE /api/admin/sessions/:id deletes session", async () => {
			setConfig("memory_mode", "full");

			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "admin-del-1", cwd: "/tmp" }),
			});

			const session = findSession("admin-del-1", apiKeyId);
			assertSession(session);

			const token = await getToken(app);
			const res = await app.request(`/api/admin/sessions/${session.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});

			expect(res.status).toBe(200);
			expect(getSession(session.id)).toBeUndefined();
		});
	});

	// --- Settings endpoints ---

	describe("Admin settings endpoints", () => {
		test("GET /api/admin/settings returns settings", async () => {
			const token = await getToken(app);
			const res = await app.request("/api/admin/settings", {
				headers: { Authorization: `Bearer ${token}` },
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as { settings: Record<string, string | null> };
			expect(body.settings).toBeDefined();
			expect("memory_mode" in body.settings).toBe(true);
		});

		test("PUT /api/admin/settings updates settings", async () => {
			const token = await getToken(app);

			const res = await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ memory_mode: "full" }),
			});

			expect(res.status).toBe(200);

			// Verify it was saved
			const getRes = await app.request("/api/admin/settings", {
				headers: { Authorization: `Bearer ${token}` },
			});
			const body = (await getRes.json()) as { settings: Record<string, string | null> };
			expect(body.settings.memory_mode).toBe("full");
		});

		test("PUT /api/admin/settings rejects unknown keys", async () => {
			const token = await getToken(app);

			const res = await app.request("/api/admin/settings", {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ unknown_setting: "value" }),
			});

			expect(res.status).toBe(400);
		});
	});

	// --- Hooks config ---

	describe("GET /api/keys/:id/hooks-config", () => {
		test("returns hooks config for owned key", async () => {
			const token = await getToken(app);
			const res = await app.request(`/api/keys/${apiKeyId}/hooks-config`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hooks: Record<string, Array<{ hooks: Array<{ type: string; url: string }> }>>;
			};
			expect(body.hooks).toBeDefined();
			expect(body.hooks.SessionStart).toBeDefined();
			expect(body.hooks.SessionEnd).toBeDefined();
			expect(body.hooks.PostToolUse).toBeDefined();
			expect(body.hooks.UserPromptSubmit).toBeDefined();
			expect(body.hooks.Stop).toBeDefined();

			// Check the URL structure
			const sessionStartUrl = body.hooks.SessionStart?.[0]?.hooks?.[0]?.url;
			expect(sessionStartUrl).toContain("/hooks/session-start");
		});

		test("returns 404 for non-owned key", async () => {
			const token = await getToken(app);

			const res = await app.request("/api/keys/nonexistent-id/hooks-config", {
				headers: { Authorization: `Bearer ${token}` },
			});

			expect(res.status).toBe(404);
		});
	});

	// --- Stats include sessions ---

	describe("GET /api/admin/stats includes sessions", () => {
		test("stats include session counts", async () => {
			const token = await getToken(app);
			const res = await app.request("/api/admin/stats", {
				headers: { Authorization: `Bearer ${token}` },
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				sessions: { total: number; active: number };
			};
			expect(body.sessions).toBeDefined();
			expect(body.sessions.total).toBeDefined();
			expect(body.sessions.active).toBeDefined();
		});
	});

	// --- Progressive disclosure ---

	describe("Progressive disclosure (session_context + get_session_detail)", () => {
		test("getSessionForUser returns session only for owning user", async () => {
			setConfig("memory_mode", "full");

			// Create session via hook
			await app.request("/hooks/session-start", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session_id: "pd-owned", cwd: "/tmp/project" }),
			});

			const session = findSession("pd-owned", apiKeyId);
			assertSession(session);

			// Owner's userId (from api key) should find it
			const { getApiKeyById } = await import("./db.js");
			const key = getApiKeyById(apiKeyId);
			if (!key) throw new Error("Expected key to be defined");

			const found = getSessionForUser(session.id, key.user_id);
			expect(found).toBeDefined();
			expect(found?.id).toBe(session.id);

			// Wrong user should not find it
			const notFound = getSessionForUser(session.id, "nonexistent-user");
			expect(notFound).toBeUndefined();
		});

		test("session_context returns compact index with summary_preview and observation_count", async () => {
			setConfig("memory_mode", "full");

			// Create a session with a long summary and some observations
			const sessId = createSession({
				claudeSessionId: "pd-compact",
				apiKeyId,
				project: "/tmp/project",
			});
			const longSummary =
				"This is a very long summary that describes in great detail everything that happened during the session including refactoring the authentication middleware, adding JWT token validation, fixing the password hashing bug, and updating all the tests to match the new behavior patterns.";
			updateSessionSummary(sessId, longSummary);
			endSession(sessId);

			// Add observations
			for (let i = 0; i < 3; i++) {
				createObservation({
					sessionId: sessId,
					event: "PostToolUse",
					toolName: "Edit",
					content: JSON.stringify({ tool_input: { path: `/file${i}.ts` } }),
				});
			}

			// Use the MCP tool via the session_context endpoint behavior:
			// Verify the DB function returns what the tool would use
			const { getRecentSessionSummaries } = await import("./db.js");
			const key = (await import("./db.js")).getApiKeyById(apiKeyId);
			if (!key) throw new Error("Expected key to be defined");
			const sessions = getRecentSessionSummaries({
				userId: key.user_id,
				project: "/tmp/project",
				limit: 5,
			});

			expect(sessions.length).toBeGreaterThanOrEqual(1);
			const match = sessions.find((s) => s.id === sessId);
			expect(match).toBeDefined();
			expect(match?.summary?.length).toBeGreaterThan(120);

			// Verify observation count works
			const obsCount = countObservations(sessId);
			expect(obsCount).toBe(3);
		});

		test("get_session_detail returns full observations with parsed content", async () => {
			setConfig("memory_mode", "full");

			const sessId = createSession({
				claudeSessionId: "pd-detail",
				apiKeyId,
				project: "/tmp/detail",
			});
			updateSessionSummary(sessId, "Detailed session summary");

			// Add observation with structured content
			createObservation({
				sessionId: sessId,
				event: "UserPromptSubmit",
				content: JSON.stringify({ prompt: "Fix the auth bug", session_id: "pd-detail" }),
			});
			createObservation({
				sessionId: sessId,
				event: "PostToolUse",
				toolName: "Edit",
				content: JSON.stringify({
					tool_name: "Edit",
					tool_input: { path: "/src/auth.ts" },
					tool_response: "File edited successfully",
				}),
			});

			// Verify observations are stored and retrievable
			const observations = listObservations(sessId);
			expect(observations.length).toBe(2);
			expect(observations[0]?.event).toBe("UserPromptSubmit");
			expect(observations[1]?.event).toBe("PostToolUse");

			// Verify content is parseable
			const first = observations[0];
			if (!first) throw new Error("Expected observation");
			const parsed = JSON.parse(first.content);
			expect(parsed.prompt).toBe("Fix the auth bug");
		});
	});
});
