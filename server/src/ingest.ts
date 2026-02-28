import { Hono } from "hono";
import { bearerKeyMiddleware } from "./auth.js";
import { createMemory, getConfigWithEnv, getMemory, updateMemorySummary } from "./db.js";
import { getProvider } from "./embeddings.js";
import type { AppEnv } from "./env.js";
import { searchMemories, upsertMemory } from "./qdrant.js";

const VALID_SCOPES = ["session", "project", "global"] as const;
type Scope = (typeof VALID_SCOPES)[number];

function isValidScope(scope: string): scope is Scope {
	return VALID_SCOPES.includes(scope as Scope);
}

const DEFAULT_DEDUP_THRESHOLD = 0.92;

function getDedupThreshold(): number {
	const str = getConfigWithEnv("dedup_threshold", "YAMS_DEDUP_THRESHOLD");
	if (!str) return DEFAULT_DEDUP_THRESHOLD;
	const num = Number(str);
	if (!Number.isFinite(num)) return DEFAULT_DEDUP_THRESHOLD;
	return Math.min(Math.max(num, 0.5), 1.0);
}

interface StoreMemoryParams {
	summary: string;
	apiKeyId: string;
	apiKeyLabel: string;
	userId: string;
	gitRemote?: string | null;
	scope?: string;
	metadata?: Record<string, unknown> | null;
	force?: boolean;
	replace?: string;
}

interface StoredMemory {
	id: string;
	summary: string;
	scope: string;
	git_remote: string | null;
	created_at: string;
}

export interface DuplicateMemory {
	duplicate: true;
	existing_id: string;
	existing_summary: string;
	similarity: number;
}

export type StoreMemoryResult = StoredMemory | DuplicateMemory;

function isDuplicate(result: StoreMemoryResult): result is DuplicateMemory {
	return "duplicate" in result;
}

export { isDuplicate };

export async function storeMemory(params: StoreMemoryParams): Promise<StoreMemoryResult> {
	const scope = params.scope ?? "session";
	if (!isValidScope(scope)) {
		throw new StoreMemoryError(
			`Invalid scope. Must be one of: ${VALID_SCOPES.join(", ")}`,
			"validation",
		);
	}

	const gitRemote = params.gitRemote?.trim() || null;
	const metadata = params.metadata ? JSON.stringify(params.metadata) : null;

	let vector: number[];
	try {
		vector = await getProvider().embed(params.summary);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		throw new StoreMemoryError(`Embedding provider error: ${message}`, "embedding");
	}

	// Replace mode: overwrite an existing memory
	if (params.replace) {
		const existing = getMemory(params.replace);
		if (!existing) {
			throw new StoreMemoryError("Memory to replace not found.", "validation");
		}

		updateMemorySummary(params.replace, params.summary);

		try {
			await upsertMemory(params.replace, vector, {
				memory_id: params.replace,
				user_id: params.userId,
				git_remote: gitRemote,
				scope,
				api_key_label: params.apiKeyLabel,
				created_at: existing.created_at,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			throw new StoreMemoryError(`Vector storage error: ${message}`, "vector");
		}

		return {
			id: params.replace,
			summary: params.summary,
			scope,
			git_remote: gitRemote,
			created_at: existing.created_at,
		};
	}

	// Dedup check: search for similar memories from the same user
	if (!params.force) {
		const threshold = getDedupThreshold();
		try {
			const similar = await searchMemories(vector, { user_id: params.userId }, 1);
			const top = similar[0];
			if (top && top.score >= threshold) {
				const existingId = String(top.id);
				const existingMemory = getMemory(existingId);
				return {
					duplicate: true,
					existing_id: existingId,
					existing_summary: existingMemory?.summary ?? String(top.payload?.summary ?? ""),
					similarity: Math.round(top.score * 1000) / 1000,
				};
			}
		} catch {
			// Qdrant unavailable — skip dedup, store anyway
		}
	}

	const id = crypto.randomUUID();
	const createdAt = new Date().toISOString();

	createMemory({
		id,
		apiKeyId: params.apiKeyId,
		gitRemote,
		scope,
		summary: params.summary,
		metadata,
	});

	try {
		await upsertMemory(id, vector, {
			memory_id: id,
			user_id: params.userId,
			git_remote: gitRemote,
			scope,
			api_key_label: params.apiKeyLabel,
			created_at: createdAt,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		throw new StoreMemoryError(`Vector storage error: ${message}`, "vector");
	}

	return { id, summary: params.summary, scope, git_remote: gitRemote, created_at: createdAt };
}

export class StoreMemoryError extends Error {
	constructor(
		message: string,
		readonly kind: "validation" | "embedding" | "vector",
	) {
		super(message);
	}
}

// --- HTTP route ---

interface IngestBody {
	summary?: string;
	git_remote?: string;
	scope?: string;
	metadata?: Record<string, unknown>;
	force?: boolean;
	replace?: string;
}

const ingest = new Hono<AppEnv>();

ingest.use("*", bearerKeyMiddleware);

ingest.post("/", async (c) => {
	const body = await c.req.json<IngestBody>();

	const summary = body.summary?.trim();
	if (!summary) {
		return c.json({ error: "Summary is required." }, 400);
	}
	if (summary.length > 10_000) {
		return c.json({ error: "Summary must be 10,000 characters or fewer." }, 400);
	}

	const apiKey = c.get("apiKey");

	try {
		const result = await storeMemory({
			summary,
			apiKeyId: apiKey.id,
			apiKeyLabel: apiKey.label,
			userId: apiKey.user_id,
			gitRemote: body.git_remote,
			scope: body.scope,
			metadata: body.metadata,
			force: body.force,
			replace: body.replace,
		});

		if (isDuplicate(result)) {
			return c.json(result, 200);
		}

		return c.json(result, 201);
	} catch (err) {
		if (err instanceof StoreMemoryError) {
			const status = err.kind === "validation" ? 400 : 502;
			return c.json({ error: err.message }, status);
		}
		throw err;
	}
});

export { ingest };
