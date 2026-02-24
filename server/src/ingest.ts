import { Hono } from "hono";
import { bearerKeyMiddleware } from "./auth.js";
import { createMemory } from "./db.js";
import { getProvider } from "./embeddings.js";
import { upsertMemory } from "./qdrant.js";

const VALID_SCOPES = ["session", "project", "global"] as const;
type Scope = (typeof VALID_SCOPES)[number];

function isValidScope(scope: string): scope is Scope {
	return VALID_SCOPES.includes(scope as Scope);
}

interface StoreMemoryParams {
	summary: string;
	apiKeyId: string;
	apiKeyLabel: string;
	gitRemote?: string | null;
	scope?: string;
	metadata?: Record<string, unknown> | null;
}

interface StoredMemory {
	id: string;
	summary: string;
	scope: string;
	git_remote: string | null;
	created_at: string;
}

export async function storeMemory(params: StoreMemoryParams): Promise<StoredMemory> {
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
}

const ingest = new Hono();

ingest.use("*", bearerKeyMiddleware);

ingest.post("/", async (c) => {
	const body = await c.req.json<IngestBody>();

	const summary = body.summary?.trim();
	if (!summary) {
		return c.json({ error: "Summary is required." }, 400);
	}

	const apiKey = c.get("apiKey") as { id: string; label: string };

	try {
		const result = await storeMemory({
			summary,
			apiKeyId: apiKey.id,
			apiKeyLabel: apiKey.label,
			gitRemote: body.git_remote,
			scope: body.scope,
			metadata: body.metadata,
		});
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
