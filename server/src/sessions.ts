import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { validateBearerKey } from "./auth.js";
import {
	countUncompressedObservations,
	createObservation,
	endSession,
	findOrCreateSession,
	findSession,
	getConfig,
	getConfigWithEnv,
	getRecentSessionSummaries,
} from "./db.js";
import type { AppEnv } from "./env.js";
import { bus } from "./events.js";
import { applyPrivacyFilters } from "./privacy.js";

const log = getLogger(["husk", "sessions"]);

const SKIPPED_TOOLS = new Set(["Read", "Glob", "Grep"]);

const VALID_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop"]);

const MAX_CONTENT_SIZE = 50_000;

const MAX_FIELD_LENGTH = 1024;

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function getMemoryMode(): string {
	return getConfigWithEnv("memory_mode", "HUSK_MEMORY_MODE") ?? "simple";
}

// --- Observation enrichment (deterministic, no LLM) ---

interface EnrichedFields {
	prompt: string | null;
	toolInputSummary: string | null;
	filesModified: string | null;
}

function enrichObservation(event: string, body: Record<string, unknown>): EnrichedFields {
	const result: EnrichedFields = {
		prompt: null,
		toolInputSummary: null,
		filesModified: null,
	};

	if (event === "UserPromptSubmit" && typeof body.prompt === "string") {
		result.prompt = body.prompt.slice(0, 2000);
	}

	if (
		event === "PostToolUse" &&
		typeof body.tool_input === "object" &&
		body.tool_input !== null &&
		!Array.isArray(body.tool_input)
	) {
		const input = body.tool_input as Record<string, unknown>;
		const toolName = typeof body.tool_name === "string" ? body.tool_name : "";

		// Extract file paths
		const files: string[] = [];
		if (typeof input.file_path === "string") files.push(input.file_path);
		else if (typeof input.path === "string") files.push(input.path);
		if (typeof input.notebook_path === "string") files.push(input.notebook_path);

		// Generate input summary
		if (typeof input.command === "string") {
			result.toolInputSummary = input.command.slice(0, 500);
		} else if (files.length > 0) {
			result.toolInputSummary = `${toolName} ${files[0]}`.slice(0, 500);
		} else {
			result.toolInputSummary = JSON.stringify(input).slice(0, 500);
		}

		// Only track files for write operations
		if ((WRITE_TOOLS.has(toolName) || toolName === "Bash") && files.length > 0) {
			result.filesModified = JSON.stringify(files);
		}
	}

	return result;
}

const sessions = new Hono<AppEnv>();

// --- POST /hooks/session-start ---

sessions.post("/session-start", async (c) => {
	const result = await validateBearerKey(c.req.header("Authorization"));
	if ("error" in result) {
		return c.json({ error: result.error }, 401);
	}

	const apiKey = result.key;

	if (getMemoryMode() === "simple") {
		return c.json({}, 200);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON." }, 400);
	}

	const claudeSessionId = String(body.session_id ?? "");
	if (!claudeSessionId) {
		return c.json({ error: "session_id is required." }, 400);
	}

	const rawProject =
		(c.req.query("project") as string | undefined) ??
		(typeof body.cwd === "string" ? body.cwd : null);
	const project = rawProject ? rawProject.slice(0, MAX_FIELD_LENGTH) : null;

	findOrCreateSession({
		claudeSessionId,
		apiKeyId: apiKey.id,
		project,
	});

	// Fetch recent session summaries for context injection
	const rawCount = Number(getConfig("session_context_count") ?? "5");
	const contextCount = Number.isFinite(rawCount) ? Math.min(Math.max(rawCount, 1), 20) : 5;
	const recentSessions = getRecentSessionSummaries({
		userId: apiKey.user_id,
		project,
		limit: contextCount,
	});

	if (recentSessions.length === 0) {
		return c.json({}, 200);
	}

	const contextLines = recentSessions.map((s) => {
		const date = s.started_at.split("T")[0];
		const proj = s.project ? ` [${s.project}]` : "";
		return `- ${date}${proj}: ${s.summary}`;
	});

	let additionalContext = `Previous session context:\n${contextLines.join("\n")}`;

	// When compression is client-mode, tell the LLM how to compress
	const compressionMode = getConfigWithEnv("compression_mode", "HUSK_COMPRESSION_MODE") ?? "client";
	if (compressionMode === "client") {
		additionalContext +=
			"\n\nHUSK compression mode: client. When prompted about observation compression, use the compress_session prompt to summarize accumulated observations.";
	}

	return c.json(
		{
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext,
			},
		},
		200,
	);
});

// --- POST /hooks/observation (UserPromptSubmit, PostToolUse, Stop) ---

sessions.post("/observation", async (c) => {
	const result = await validateBearerKey(c.req.header("Authorization"));
	if ("error" in result) {
		return c.json({ error: result.error }, 401);
	}

	const apiKey = result.key;

	if (getMemoryMode() === "simple") {
		return c.json({}, 200);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON." }, 400);
	}

	const claudeSessionId = String(body.session_id ?? "");
	if (!claudeSessionId) {
		return c.json({ error: "session_id is required." }, 400);
	}

	const event = String(body.event ?? "");
	if (!event) {
		return c.json({ error: "event is required." }, 400);
	}
	if (!VALID_EVENTS.has(event)) {
		return c.json({ error: "Invalid event type." }, 400);
	}

	// Skip low-value tools
	const toolName = typeof body.tool_name === "string" ? body.tool_name.slice(0, 256) : null;
	if (event === "PostToolUse" && toolName && SKIPPED_TOOLS.has(toolName)) {
		return c.json({}, 200);
	}

	const rawProject =
		(c.req.query("project") as string | undefined) ??
		(typeof body.cwd === "string" ? body.cwd : null);
	const project = rawProject ? rawProject.slice(0, MAX_FIELD_LENGTH) : null;

	const session = findOrCreateSession({
		claudeSessionId,
		apiKeyId: apiKey.id,
		project,
	});

	// Apply privacy filters (tags + configurable regex patterns)
	if (typeof body.prompt === "string") {
		body.prompt = applyPrivacyFilters(body.prompt);
	}
	if (typeof body.tool_response === "string") {
		body.tool_response = applyPrivacyFilters(body.tool_response);
	}

	// Enrich observation with structured fields
	const enriched = enrichObservation(event, body);

	let content = JSON.stringify(body);
	if (content.length > MAX_CONTENT_SIZE) {
		content = content.slice(0, MAX_CONTENT_SIZE);
	}

	try {
		createObservation({
			sessionId: session.id,
			event,
			toolName,
			content,
			prompt: enriched.prompt,
			toolInputSummary: enriched.toolInputSummary,
			filesModified: enriched.filesModified,
		});

		const uncompressedCount = countUncompressedObservations(session.id);
		bus.emit("observation:created", { sessionId: session.id, uncompressedCount });

		return c.json({ uncompressed_count: uncompressedCount }, 200);
	} catch (err) {
		log.error("Failed to create observation: {error}", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return c.json({}, 200);
});

// --- POST /hooks/session-end ---

sessions.post("/session-end", async (c) => {
	const result = await validateBearerKey(c.req.header("Authorization"));
	if ("error" in result) {
		return c.json({ error: result.error }, 401);
	}

	const apiKey = result.key;

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON." }, 400);
	}

	const claudeSessionId = String(body.session_id ?? "");
	if (!claudeSessionId) {
		return c.json({ error: "session_id is required." }, 400);
	}

	const session = findSession(claudeSessionId, apiKey.id);
	if (session) {
		endSession(session.id);
		log.info("Session {id} ended", { id: session.id });
		bus.emit("session:ended", session.id);
	}

	return c.json({}, 200);
});

export { sessions };
