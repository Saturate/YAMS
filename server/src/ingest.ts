import { Hono } from "hono";
import { bearerKeyMiddleware } from "./auth.js";
import {
	createMemory,
	getConfigWithEnv,
	getMemory,
	getMemoryForUser,
	updateMemorySummary,
} from "./db.js";
import { getProvider } from "./embeddings.js";
import type { AppEnv } from "./env.js";
import { getStorageProvider } from "./storage.js";

const VALID_SCOPES = ["session", "project", "workspace", "global"] as const;
type Scope = (typeof VALID_SCOPES)[number];

function isValidScope(scope: string): scope is Scope {
	return VALID_SCOPES.includes(scope as Scope);
}

const DEFAULT_DEDUP_THRESHOLD = 0.92;

function getDedupThreshold(): number {
	const str = getConfigWithEnv("dedup_threshold", "HUSK_DEDUP_THRESHOLD");
	if (!str) return DEFAULT_DEDUP_THRESHOLD;
	const num = Number(str);
	if (!Number.isFinite(num)) return DEFAULT_DEDUP_THRESHOLD;
	return Math.min(Math.max(num, 0.5), 1.0);
}

const TTL_DEFAULTS: Record<string, string | undefined> = {
	session: "2592000",
	project: "7776000",
	workspace: "7776000",
	global: undefined,
};

function getScopeTtl(scope: string): number | null {
	const key = `ttl_default_${scope}` as const;
	const envVar = `HUSK_TTL_DEFAULT_${scope.toUpperCase()}`;
	const str = getConfigWithEnv(key, envVar) ?? TTL_DEFAULTS[scope];
	if (!str) return null;
	const num = Number(str);
	return Number.isFinite(num) && num > 0 ? num : null;
}

function getTtlMax(): number | null {
	const str = getConfigWithEnv("ttl_max", "HUSK_TTL_MAX");
	if (!str) return null;
	const num = Number(str);
	return Number.isFinite(num) && num > 0 ? num : null;
}

export function resolveExpiresAt(ttl: number | null | undefined, scope: string): string | null {
	let seconds: number | null;

	if (ttl === null) {
		// Explicit null = forever
		seconds = null;
	} else if (ttl !== undefined && ttl > 0) {
		seconds = ttl;
	} else {
		// 0 or undefined = scope default
		seconds = getScopeTtl(scope);
	}

	const max = getTtlMax();
	if (max !== null) {
		// Ceiling: cap any TTL (even "forever") to the admin max
		seconds = seconds === null ? max : Math.min(seconds, max);
	}

	if (seconds === null) return null;
	return new Date(Date.now() + seconds * 1000).toISOString();
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
	ttl?: number | null;
	workspaceId?: string | null;
}

interface StoredMemory {
	id: string;
	summary: string;
	scope: string;
	git_remote: string | null;
	created_at: string;
	expires_at: string | null;
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
	const expiresAt = resolveExpiresAt(params.ttl, scope);
	const workspaceId = params.workspaceId ?? null;

	let vector: number[];
	try {
		vector = await getProvider().embed(params.summary);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		throw new StoreMemoryError(`Embedding provider error: ${message}`, "embedding");
	}

	// Replace mode: overwrite an existing memory
	if (params.replace) {
		const existing = getMemoryForUser(params.replace, params.userId);
		if (!existing) {
			throw new StoreMemoryError("Memory to replace not found.", "validation");
		}

		updateMemorySummary(params.replace, params.summary);

		try {
			await getStorageProvider().upsert(params.replace, vector, {
				memory_id: params.replace,
				user_id: params.userId,
				git_remote: gitRemote,
				scope,
				api_key_label: params.apiKeyLabel,
				created_at: existing.created_at,
				expires_at: expiresAt,
				workspace_id: workspaceId,
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
			expires_at: expiresAt,
		};
	}

	// Dedup check: search for similar memories from the same user
	if (!params.force) {
		const threshold = getDedupThreshold();
		try {
			const similar = await getStorageProvider().search(vector, { user_id: params.userId }, 1);
			const top = similar[0];
			if (top && top.score >= threshold) {
				const existingId = top.id;
				const existingMemory = getMemory(existingId);
				return {
					duplicate: true,
					existing_id: existingId,
					existing_summary: existingMemory?.summary ?? String(top.payload?.summary ?? ""),
					similarity: Math.round(top.score * 1000) / 1000,
				};
			}
		} catch {
			// Vector storage unavailable — skip dedup, store anyway
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
		expiresAt,
		workspaceId,
	});

	try {
		await getStorageProvider().upsert(id, vector, {
			memory_id: id,
			user_id: params.userId,
			git_remote: gitRemote,
			scope,
			api_key_label: params.apiKeyLabel,
			created_at: createdAt,
			expires_at: expiresAt,
			workspace_id: workspaceId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		throw new StoreMemoryError(`Vector storage error: ${message}`, "vector");
	}

	return {
		id,
		summary: params.summary,
		scope,
		git_remote: gitRemote,
		created_at: createdAt,
		expires_at: expiresAt,
	};
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
	ttl?: number | null;
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
			ttl: body.ttl,
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
