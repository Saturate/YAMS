import { beforeEach, describe, expect, test } from "bun:test";
import { parseSummary } from "./compression.js";
import {
	countUncompressedObservations,
	createObservation,
	createSession,
	endSession,
	findSession,
	getSessionFilesModified,
	getStaleActiveSessions,
	listObservations,
	setConfig,
} from "./db.js";
import { bus } from "./events.js";
import { applyPrivacyFilters, resetPrivacyCache, stripPrivateTags } from "./privacy.js";
import { createTestApp, getToken, setupAdmin } from "./test-helpers.js";

describe("Privacy tag stripping", () => {
	test("removes single private tag", () => {
		const input = "Hello <private>secret</private> world";
		expect(stripPrivateTags(input)).toBe("Hello  world");
	});

	test("removes multiple private tags", () => {
		const input = "A <private>x</private> B <private>y</private> C";
		expect(stripPrivateTags(input)).toBe("A  B  C");
	});

	test("handles multiline private content", () => {
		const input = "before <private>\nline1\nline2\n</private> after";
		expect(stripPrivateTags(input)).toBe("before  after");
	});

	test("is case-insensitive", () => {
		const input = "Hello <PRIVATE>secret</PRIVATE> world";
		expect(stripPrivateTags(input)).toBe("Hello  world");
	});

	test("returns original text when no tags present", () => {
		expect(stripPrivateTags("no tags here")).toBe("no tags here");
	});

	test("handles empty string", () => {
		expect(stripPrivateTags("")).toBe("");
	});

	test("trims whitespace from result", () => {
		expect(stripPrivateTags("  hello  ")).toBe("hello");
	});
});

describe("Summary parsing", () => {
	test("parses all four sections", () => {
		const summary = `## Request
Refactor the auth module to use JWT tokens.

## Completed
Updated auth.ts with JWT validation. Added middleware in app.ts.

## Learned
The existing session store was Redis-based, switched to stateless JWT.

## Next Steps
- Add refresh token rotation
- Update the logout endpoint
- Write integration tests`;

		const parsed = parseSummary(summary);
		expect(parsed.request).toBe("Refactor the auth module to use JWT tokens.");
		expect(parsed.completed).toContain("Updated auth.ts");
		expect(parsed.learned).toContain("Redis-based");
		expect(parsed.nextSteps).toEqual([
			"Add refresh token rotation",
			"Update the logout endpoint",
			"Write integration tests",
		]);
		expect(parsed.raw).toBe(summary);
	});

	test("handles missing sections gracefully", () => {
		const summary = "Just a plain text summary with no headers.";
		const parsed = parseSummary(summary);
		expect(parsed.request).toBeNull();
		expect(parsed.completed).toBeNull();
		expect(parsed.learned).toBeNull();
		expect(parsed.nextSteps).toEqual([]);
		expect(parsed.raw).toBe(summary);
	});

	test("handles partial sections", () => {
		const summary = `## Request
Fix the login bug.

## Completed
Patched the validation logic.`;

		const parsed = parseSummary(summary);
		expect(parsed.request).toBe("Fix the login bug.");
		expect(parsed.completed).toBe("Patched the validation logic.");
		expect(parsed.learned).toBeNull();
		expect(parsed.nextSteps).toEqual([]);
	});

	test("handles next steps with * bullets", () => {
		const summary = `## Next Steps
* First thing
* Second thing`;

		const parsed = parseSummary(summary);
		expect(parsed.nextSteps).toEqual(["First thing", "Second thing"]);
	});

	test("handles empty summary", () => {
		const parsed = parseSummary("");
		expect(parsed.request).toBeNull();
		expect(parsed.nextSteps).toEqual([]);
		expect(parsed.raw).toBe("");
	});
});

describe("Configurable privacy regex patterns", () => {
	beforeEach(() => {
		createTestApp();
		resetPrivacyCache();
	});

	test("redacts text matching configured patterns", () => {
		setConfig("privacy_patterns", "sk-[a-zA-Z0-9]{20,}");
		const input = "Use key sk-abcdefghijklmnopqrstuvwxyz for auth";
		const result = applyPrivacyFilters(input);
		expect(result).toBe("Use key [REDACTED] for auth");
		expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
	});

	test("applies multiple patterns (newline separated)", () => {
		setConfig("privacy_patterns", "sk-[a-zA-Z0-9]+\npassword\\s*=\\s*\\S+");
		const input = "key: sk-test123 and password = hunter2";
		const result = applyPrivacyFilters(input);
		expect(result).not.toContain("sk-test123");
		expect(result).not.toContain("hunter2");
	});

	test("skips comment lines starting with #", () => {
		setConfig("privacy_patterns", "# This is a comment\nsk-[a-zA-Z0-9]+");
		const input = "key: sk-test123";
		const result = applyPrivacyFilters(input);
		expect(result).not.toContain("sk-test123");
	});

	test("skips blank lines", () => {
		setConfig("privacy_patterns", "\n\nsk-[a-zA-Z0-9]+\n\n");
		const input = "key: sk-test123";
		const result = applyPrivacyFilters(input);
		expect(result).not.toContain("sk-test123");
	});

	test("skips invalid regex without breaking", () => {
		setConfig("privacy_patterns", "[invalid(\nsk-[a-zA-Z0-9]+");
		const input = "key: sk-test123";
		const result = applyPrivacyFilters(input);
		expect(result).not.toContain("sk-test123");
	});

	test("still strips private tags when patterns configured", () => {
		setConfig("privacy_patterns", "sk-[a-zA-Z0-9]+");
		const input = "key: sk-test123 and <private>secret</private>";
		const result = applyPrivacyFilters(input);
		expect(result).not.toContain("sk-test123");
		expect(result).not.toContain("secret");
	});

	test("returns text unchanged when no patterns configured", () => {
		const input = "no patterns configured here";
		expect(applyPrivacyFilters(input)).toBe("no patterns configured here");
	});

	test("cache invalidation works", () => {
		setConfig("privacy_patterns", "secret123");
		expect(applyPrivacyFilters("has secret123 in it")).toContain("[REDACTED]");

		resetPrivacyCache();
		// After reset, re-reads config (which still has the pattern)
		expect(applyPrivacyFilters("has secret123 in it")).toContain("[REDACTED]");
	});
});

describe("Observation enrichment", () => {
	let app: ReturnType<typeof createTestApp>;
	let apiKey: string;
	let apiKeyId: string;

	beforeEach(async () => {
		app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);
		const res = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "enrich-test" }),
		});
		const body = (await res.json()) as { key: string; id: string };
		apiKey = body.key;
		apiKeyId = body.id;
	});

	test("extracts prompt from UserPromptSubmit", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-prompt",
				event: "UserPromptSubmit",
				prompt: "Fix the authentication bug in login.ts",
			}),
		});

		const session = findSession("enrich-prompt", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs.length).toBe(1);
		expect(obs[0]?.prompt).toBe("Fix the authentication bug in login.ts");
	});

	test("extracts tool_input_summary from PostToolUse with command", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-bash",
				event: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "npm test -- --coverage" },
			}),
		});

		const session = findSession("enrich-bash", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs[0]?.tool_input_summary).toBe("npm test -- --coverage");
	});

	test("extracts file_path and generates summary for Edit tool", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-edit",
				event: "PostToolUse",
				tool_name: "Edit",
				tool_input: { file_path: "/src/auth.ts", old_string: "foo", new_string: "bar" },
			}),
		});

		const session = findSession("enrich-edit", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs[0]?.tool_input_summary).toBe("Edit /src/auth.ts");
		expect(obs[0]?.files_modified).toBe(JSON.stringify(["/src/auth.ts"]));
	});

	test("tracks files_modified for Write tool", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-write",
				event: "PostToolUse",
				tool_name: "Write",
				tool_input: { file_path: "/src/new-file.ts", content: "export const x = 1;" },
			}),
		});

		const session = findSession("enrich-write", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs[0]?.files_modified).toBe(JSON.stringify(["/src/new-file.ts"]));
	});

	test("does not track files_modified for non-write tools", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-task",
				event: "PostToolUse",
				tool_name: "Task",
				tool_input: { path: "/src/something.ts" },
			}),
		});

		const session = findSession("enrich-task", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs[0]?.files_modified).toBeNull();
	});

	test("strips private tags from prompt before storage", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-private",
				event: "UserPromptSubmit",
				prompt: "Use API key <private>sk-12345</private> for auth",
			}),
		});

		const session = findSession("enrich-private", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs[0]?.prompt).toBe("Use API key  for auth");
		// Also verify the raw content doesn't have the secret
		expect(obs[0]?.content).not.toContain("sk-12345");
	});

	test("extracts notebook_path for NotebookEdit", async () => {
		setConfig("memory_mode", "full");

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "enrich-notebook",
				event: "PostToolUse",
				tool_name: "NotebookEdit",
				tool_input: { notebook_path: "/notebooks/analysis.ipynb", cell_number: 3 },
			}),
		});

		const session = findSession("enrich-notebook", apiKeyId);
		if (!session) throw new Error("Session not found");
		const obs = listObservations(session.id);
		expect(obs[0]?.tool_input_summary).toBe("NotebookEdit /notebooks/analysis.ipynb");
		expect(obs[0]?.files_modified).toBe(JSON.stringify(["/notebooks/analysis.ipynb"]));
	});
});

describe("Files modified aggregation", () => {
	let app: ReturnType<typeof createTestApp>;
	let keyId: string;

	beforeEach(async () => {
		app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);
		const res = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "files-test" }),
		});
		const body = (await res.json()) as { key: string; id: string };
		keyId = body.id;
	});

	test("aggregates distinct files across observations", () => {
		const sessId = createSession({
			claudeSessionId: "files-agg",
			apiKeyId: keyId,
		});

		createObservation({
			sessionId: sessId,
			event: "PostToolUse",
			toolName: "Edit",
			content: "{}",
			filesModified: JSON.stringify(["/src/a.ts"]),
		});
		createObservation({
			sessionId: sessId,
			event: "PostToolUse",
			toolName: "Write",
			content: "{}",
			filesModified: JSON.stringify(["/src/b.ts"]),
		});
		createObservation({
			sessionId: sessId,
			event: "PostToolUse",
			toolName: "Edit",
			content: "{}",
			filesModified: JSON.stringify(["/src/a.ts"]),
		});

		const files = getSessionFilesModified(sessId);
		expect(files.sort()).toEqual(["/src/a.ts", "/src/b.ts"]);
	});

	test("returns empty array when no files modified", () => {
		const sessId = createSession({
			claudeSessionId: "files-empty",
			apiKeyId: keyId,
		});
		createObservation({
			sessionId: sessId,
			event: "UserPromptSubmit",
			content: "{}",
		});

		const files = getSessionFilesModified(sessId);
		expect(files).toEqual([]);
	});
});

describe("Batch compression helpers", () => {
	let app: ReturnType<typeof createTestApp>;
	let keyId: string;

	beforeEach(async () => {
		app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);
		const res = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "batch-test" }),
		});
		const body = (await res.json()) as { key: string; id: string };
		keyId = body.id;
	});

	test("countUncompressedObservations returns correct count", () => {
		const sessId = createSession({
			claudeSessionId: "batch-count",
			apiKeyId: keyId,
		});

		for (let i = 0; i < 5; i++) {
			createObservation({
				sessionId: sessId,
				event: "UserPromptSubmit",
				content: JSON.stringify({ prompt: `test ${i}` }),
			});
		}

		expect(countUncompressedObservations(sessId)).toBe(5);
	});

	test("getStaleActiveSessions finds sessions with old observations", () => {
		const sessId = createSession({
			claudeSessionId: "stale-check",
			apiKeyId: keyId,
		});

		createObservation({
			sessionId: sessId,
			event: "UserPromptSubmit",
			content: "{}",
		});

		// With 0 minutes interval, all sessions should be stale
		const stale = getStaleActiveSessions(0);
		const found = stale.find((s) => s.id === sessId);
		expect(found).toBeDefined();
	});

	test("getStaleActiveSessions excludes ended sessions", () => {
		const sessId = createSession({
			claudeSessionId: "stale-ended",
			apiKeyId: keyId,
		});

		createObservation({
			sessionId: sessId,
			event: "UserPromptSubmit",
			content: "{}",
		});
		endSession(sessId);

		const stale = getStaleActiveSessions(0);
		const found = stale.find((s) => s.id === sessId);
		expect(found).toBeUndefined();
	});
});

describe("Event bus emission", () => {
	let app: ReturnType<typeof createTestApp>;
	let apiKey: string;
	let apiKeyId: string;

	beforeEach(async () => {
		app = createTestApp();
		await setupAdmin(app);
		const token = await getToken(app);
		const res = await app.request("/api/keys", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ label: "event-test" }),
		});
		const body = (await res.json()) as { key: string; id: string };
		apiKey = body.key;
		apiKeyId = body.id;
		bus.removeAllListeners();
	});

	test("emits observation:created on new observation", async () => {
		setConfig("memory_mode", "full");

		let emittedPayload: { sessionId: string; uncompressedCount: number } | undefined;
		bus.on("observation:created", (payload) => {
			emittedPayload = payload;
		});

		await app.request("/hooks/observation", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session_id: "event-obs",
				event: "UserPromptSubmit",
				prompt: "test",
			}),
		});

		expect(emittedPayload).toBeDefined();
		expect(emittedPayload?.uncompressedCount).toBe(1);
	});

	test("emits session:ended on session end", async () => {
		setConfig("memory_mode", "full");

		// Create session first
		await app.request("/hooks/session-start", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ session_id: "event-end", cwd: "/tmp" }),
		});

		let endedSessionId: string | null = null;
		bus.on("session:ended", (id) => {
			endedSessionId = id;
		});

		await app.request("/hooks/session-end", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ session_id: "event-end" }),
		});

		expect(endedSessionId).not.toBeNull();
	});
});
