import { getLogger } from "@logtape/logtape";
import {
	type ObservationRow,
	type SessionRow,
	getApiKeyById,
	getConfig,
	getConfigWithEnv,
	getSession,
	getStaleActiveSessions,
	getUncompressedObservations,
	getUncompressedSessions,
	markObservationsCompressed,
	updateSessionSummary,
} from "./db.js";
import { bus } from "./events.js";
import { storeMemory } from "./ingest.js";

const log = getLogger(["husk", "compression"]);

const FETCH_TIMEOUT_MS = 30_000;

const COMPRESSION_PROMPT = `Summarize this batch of coding session observations. Output these structured sections:

## Request
What the user asked to accomplish (1-2 sentences).

## Completed
What was actually done — name specific files, functions, patterns.

## Learned
Key decisions, constraints, or patterns discovered.

## Next Steps
Unfinished work or open questions.

Be specific. This summary will restore context in future sessions.

Session observations:`;

// --- Summary parsing ---

export interface ParsedSummary {
	request: string | null;
	completed: string | null;
	learned: string | null;
	nextSteps: string[];
	raw: string;
}

const SECTION_RE = /^##\s+(.+)$/gm;

export function parseSummary(summary: string): ParsedSummary {
	const result: ParsedSummary = {
		request: null,
		completed: null,
		learned: null,
		nextSteps: [],
		raw: summary,
	};

	// Split into sections by ## headers
	const sections = new Map<string, string>();
	const matches = [...summary.matchAll(SECTION_RE)];
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		if (!match) continue;
		const name = match[1]?.trim().toLowerCase() ?? "";
		const start = match.index + match[0].length;
		const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? summary.length) : summary.length;
		sections.set(name, summary.slice(start, end).trim());
	}

	result.request = sections.get("request") ?? null;
	result.completed = sections.get("completed") ?? null;
	result.learned = sections.get("learned") ?? null;

	const nextStepsRaw = sections.get("next steps");
	if (nextStepsRaw) {
		result.nextSteps = nextStepsRaw
			.split("\n")
			.map((line) => line.replace(/^[-*]\s*/, "").trim())
			.filter(Boolean);
	}

	return result;
}

// --- Provider interface ---

export interface CompressionProvider {
	summarize(observations: ObservationRow[], project: string | null): Promise<string>;
	/** Generic completion for short classification tasks. */
	complete(prompt: string, maxTokens: number): Promise<string>;
	readonly name: string;
}

// --- Anthropic ---

interface AnthropicMessage {
	role: string;
	content: string;
}

interface AnthropicResponse {
	content: Array<{ type: string; text?: string }>;
}

class AnthropicProvider implements CompressionProvider {
	readonly name = "anthropic";

	private get apiKey(): string {
		const key = getConfigWithEnv("compression_api_key", "HUSK_COMPRESSION_API_KEY");
		if (!key) throw new Error("Anthropic API key not configured for compression");
		return key;
	}

	private get model(): string {
		return (
			getConfigWithEnv("compression_model", "HUSK_COMPRESSION_MODEL") ?? "claude-haiku-4-5-20251001"
		);
	}

	private async call(content: string, maxTokens: number): Promise<string> {
		const messages: AnthropicMessage[] = [{ role: "user", content }];

		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: maxTokens,
				messages,
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Anthropic call failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as AnthropicResponse;
		const text = data.content.find((c) => c.type === "text")?.text;
		if (!text) throw new Error("Anthropic returned empty content");
		return text.trim();
	}

	async summarize(observations: ObservationRow[], project: string | null): Promise<string> {
		const observationText = formatObservations(observations, project);
		return this.call(`${COMPRESSION_PROMPT}\n\n${observationText}`, 800);
	}

	async complete(prompt: string, maxTokens: number): Promise<string> {
		return this.call(prompt, maxTokens);
	}
}

// --- OpenRouter ---

interface ChatCompletionResponse {
	choices: Array<{ message: { content: string } }>;
}

class OpenRouterProvider implements CompressionProvider {
	readonly name = "openrouter";

	private get apiKey(): string {
		const key = getConfigWithEnv("compression_api_key", "HUSK_COMPRESSION_API_KEY");
		if (!key) throw new Error("OpenRouter API key not configured for compression");
		return key;
	}

	private get model(): string {
		return (
			getConfigWithEnv("compression_model", "HUSK_COMPRESSION_MODEL") ??
			"anthropic/claude-haiku-4-5-20251001"
		);
	}

	private get baseUrl(): string {
		return (
			getConfigWithEnv("compression_base_url", "HUSK_COMPRESSION_URL") ??
			"https://openrouter.ai/api/v1"
		);
	}

	private async call(content: string, maxTokens: number): Promise<string> {
		const res = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: maxTokens,
				messages: [{ role: "user", content }],
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`OpenRouter call failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as ChatCompletionResponse;
		const text = data.choices?.[0]?.message?.content;
		if (!text) throw new Error("OpenRouter returned empty content");
		return text.trim();
	}

	async summarize(observations: ObservationRow[], project: string | null): Promise<string> {
		const observationText = formatObservations(observations, project);
		return this.call(`${COMPRESSION_PROMPT}\n\n${observationText}`, 800);
	}

	async complete(prompt: string, maxTokens: number): Promise<string> {
		return this.call(prompt, maxTokens);
	}
}

// --- Ollama ---

interface OllamaChatResponse {
	message?: { content: string };
}

class OllamaProvider implements CompressionProvider {
	readonly name = "ollama";

	private get url(): string {
		return (
			getConfigWithEnv("compression_base_url", "HUSK_COMPRESSION_URL") ?? "http://localhost:11434"
		);
	}

	private get model(): string {
		return getConfigWithEnv("compression_model", "HUSK_COMPRESSION_MODEL") ?? "llama3.2";
	}

	private async call(content: string): Promise<string> {
		const res = await fetch(`${this.url}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.model,
				stream: false,
				messages: [{ role: "user", content }],
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Ollama call failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as OllamaChatResponse;
		const text = data.message?.content;
		if (!text) throw new Error("Ollama returned empty content");
		return text.trim();
	}

	async summarize(observations: ObservationRow[], project: string | null): Promise<string> {
		const observationText = formatObservations(observations, project);
		return this.call(`${COMPRESSION_PROMPT}\n\n${observationText}`);
	}

	async complete(prompt: string, _maxTokens: number): Promise<string> {
		return this.call(prompt);
	}
}

// --- Helpers ---

function formatObservations(observations: ObservationRow[], project: string | null): string {
	const header = project ? `Project: ${project}\n\n` : "";
	const lines = observations.map((o) => {
		const toolInfo = o.tool_name ? ` (${o.tool_name})` : "";

		// Prefer enriched columns, fall back to JSON parsing for pre-migration data
		let summary: string;
		if (o.prompt) {
			summary = o.prompt;
		} else if (o.tool_input_summary) {
			summary = o.tool_input_summary;
		} else {
			try {
				const parsed = JSON.parse(o.content) as Record<string, unknown>;
				if (o.event === "UserPromptSubmit" && typeof parsed.prompt === "string") {
					summary = parsed.prompt;
				} else if (o.event === "PostToolUse") {
					const input = parsed.tool_input ? JSON.stringify(parsed.tool_input) : "";
					summary = input.slice(0, 500);
				} else {
					summary = o.content.slice(0, 200);
				}
			} catch {
				summary = o.content.slice(0, 200);
			}
		}

		const fileTag = o.files_modified && o.files_modified !== "[]" ? ` -> ${o.files_modified}` : "";
		return `[${o.event}${toolInfo}] ${summary}${fileTag}`;
	});

	let text = header + lines.join("\n");
	if (text.length > 12_000) {
		text = `${text.slice(0, 12_000)}\n...(truncated)`;
	}
	return text;
}

// --- Provider factory ---

let provider: CompressionProvider | null = null;

export function getCompressionProvider(): CompressionProvider {
	if (provider) return provider;

	const providerName =
		getConfigWithEnv("compression_provider", "HUSK_COMPRESSION_PROVIDER") ?? "anthropic";

	switch (providerName) {
		case "openrouter":
			provider = new OpenRouterProvider();
			break;
		case "ollama":
			provider = new OllamaProvider();
			break;
		default:
			provider = new AnthropicProvider();
			break;
	}

	return provider;
}

export function setCompressionProvider(p: CompressionProvider | null): void {
	provider = p;
}

// --- Memory classification ---

import { MEMORY_TYPES, type MemoryType, generateUniqueSlug, isValidMemoryType } from "./db.js";

const CLASSIFICATION_PROMPT = `Classify the following memory content. Respond with ONLY a valid JSON object, no markdown fences.

Fields:
- "title": A concise title, max 60 characters
- "memory_type": One of: decision, solution, lesson, fact, convention, goal
- "path": A hierarchical category path like "auth/" or "api/rate-limits/" (lowercase, max 3 segments, trailing slash). Use "" if uncategorizable.

Memory content:
`;

export interface MemoryClassification {
	title: string;
	slug: string;
	memory_type: MemoryType;
	path: string;
}

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "memory";
}

interface ClassificationResponse {
	title?: string;
	memory_type?: string;
	path?: string;
}

export async function classifyMemory(
	summary: string,
	scope: string,
	gitRemote: string | null,
	opts?: { title?: string; memoryType?: string; path?: string },
): Promise<MemoryClassification> {
	const needsLlm = !opts?.title || !opts?.memoryType;

	let title = opts?.title ?? null;
	const rawType = opts?.memoryType ?? "";
	let memoryType: MemoryType = isValidMemoryType(rawType) ? rawType : "fact";
	let path = opts?.path ?? "";

	// Session-scoped memories skip LLM classification
	if (scope === "session") {
		title = title ?? summary.slice(0, 60);
		const slug = slugify(title);
		return {
			title,
			slug: generateUniqueSlug(scope, gitRemote, slug),
			memory_type: memoryType,
			path,
		};
	}

	if (needsLlm) {
		try {
			const compressionProvider = getCompressionProvider();
			const raw = await compressionProvider.complete(
				`${CLASSIFICATION_PROMPT}${summary.slice(0, 2000)}`,
				200,
			);

			// Strip markdown fences if present
			const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
			const parsed = JSON.parse(jsonStr) as ClassificationResponse;

			if (!title && parsed.title && typeof parsed.title === "string") {
				title = parsed.title.slice(0, 60);
			}
			if (!opts?.memoryType && parsed.memory_type && isValidMemoryType(parsed.memory_type)) {
				memoryType = parsed.memory_type as MemoryType;
			}
			if (!opts?.path && parsed.path && typeof parsed.path === "string") {
				path = parsed.path.slice(0, 100);
			}
		} catch (err) {
			log.warn("Memory classification failed, using defaults: {error}", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	title = title ?? summary.slice(0, 60);
	const slug = slugify(title);

	return {
		title,
		slug: generateUniqueSlug(scope, gitRemote, slug),
		memory_type: memoryType,
		path,
	};
}

// --- Config helpers ---

function getBatchSize(): number {
	const raw = Number(
		getConfigWithEnv("compression_batch_size", "HUSK_COMPRESSION_BATCH_SIZE") ?? "20",
	);
	return Number.isFinite(raw) ? Math.min(Math.max(raw, 5), 100) : 20;
}

function getIntervalMinutes(): number {
	const raw = Number(
		getConfigWithEnv("compression_interval_minutes", "HUSK_COMPRESSION_INTERVAL_MINUTES") ?? "15",
	);
	return Number.isFinite(raw) ? Math.min(Math.max(raw, 5), 60) : 15;
}

// --- Core compression logic ---

async function compressSession(session: SessionRow): Promise<void> {
	const observations = getUncompressedObservations(session.id);
	if (observations.length === 0) return;

	const compressionProvider = getCompressionProvider();
	log.info("Compressing session {id} ({count} observations) with {provider}", {
		id: session.id,
		count: observations.length,
		provider: compressionProvider.name,
	});

	const summary = await compressionProvider.summarize(observations, session.project);

	updateSessionSummary(session.id, summary);
	markObservationsCompressed(session.id);

	// Store as a searchable memory via the existing pipeline
	const apiKey = getApiKeyById(session.api_key_id);
	if (apiKey) {
		try {
			await storeMemory({
				summary,
				apiKeyId: apiKey.id,
				apiKeyLabel: apiKey.label,
				userId: apiKey.user_id,
				gitRemote: session.project,
				scope: "session",
				metadata: {
					source: "session_capture",
					session_id: session.id,
				},
			});
		} catch (err) {
			// Non-fatal: summary is stored on session even if memory pipeline fails
			log.warn("Failed to store session summary as memory: {error}", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// Guard against concurrent compressions of the same session
const compressingSessionIds = new Set<string>();

async function tryCompressSession(session: SessionRow): Promise<void> {
	if (compressingSessionIds.has(session.id)) return;
	compressingSessionIds.add(session.id);
	try {
		await compressSession(session);
	} finally {
		compressingSessionIds.delete(session.id);
	}
}

// --- One-time catch-up for sessions missed during downtime ---

export async function runCompressionCycle(): Promise<void> {
	const compressionMode = getConfigWithEnv("compression_mode", "HUSK_COMPRESSION_MODE") ?? "client";
	if (compressionMode !== "server") return;

	const sessions = getUncompressedSessions();
	for (const session of sessions) {
		try {
			await tryCompressSession(session);
		} catch (err) {
			log.error("Compression failed for session {id}: {error}", {
				id: session.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// --- Event-driven compression ---

let staleCheckInterval: ReturnType<typeof setInterval> | null = null;
let listenerInitialized = false;

export function initCompressionListener(): void {
	if (listenerInitialized) return;
	listenerInitialized = true;

	// Trigger 1: Observation count threshold
	bus.on("observation:created", ({ sessionId, uncompressedCount }) => {
		const compressionMode =
			getConfigWithEnv("compression_mode", "HUSK_COMPRESSION_MODE") ?? "client";
		if (compressionMode !== "server") return;

		const batchSize = getBatchSize();
		if (uncompressedCount >= batchSize) {
			log.info("Batch threshold reached for session {id} ({count} >= {threshold})", {
				id: sessionId,
				count: uncompressedCount,
				threshold: batchSize,
			});

			const session = getSession(sessionId);
			if (!session) return;

			tryCompressSession(session).catch((err) => {
				log.error("Batch compression failed for session {id}: {error}", {
					id: sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	});

	// Trigger 2: Session end — final flush
	bus.on("session:ended", (sessionId) => {
		const compressionMode =
			getConfigWithEnv("compression_mode", "HUSK_COMPRESSION_MODE") ?? "client";
		if (compressionMode !== "server") return;

		const session = getSession(sessionId);
		if (!session) return;

		tryCompressSession(session).catch((err) => {
			log.error("Session-end compression failed for session {id}: {error}", {
				id: sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	});

	// Trigger 3: Stale-session timer — catches long-running sessions
	staleCheckInterval = setInterval(() => {
		try {
			const compressionMode =
				getConfigWithEnv("compression_mode", "HUSK_COMPRESSION_MODE") ?? "client";
			if (compressionMode !== "server") return;

			const intervalMinutes = getIntervalMinutes();
			const staleSessions = getStaleActiveSessions(intervalMinutes);

			for (const session of staleSessions) {
				log.info("Stale-session compression triggered for {id} (>{mins}min since last obs)", {
					id: session.id,
					mins: intervalMinutes,
				});

				tryCompressSession(session).catch((err) => {
					log.error("Stale compression failed for session {id}: {error}", {
						id: session.id,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		} catch (err) {
			log.error("Stale-session check failed: {error}", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, 60_000);
}

export function stopCompressionListener(): void {
	if (staleCheckInterval) {
		clearInterval(staleCheckInterval);
		staleCheckInterval = null;
	}
	bus.removeAllListeners("observation:created");
	bus.removeAllListeners("session:ended");
	listenerInitialized = false;
}
