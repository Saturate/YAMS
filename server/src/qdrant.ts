import { getLogger } from "@logtape/logtape";
import { QdrantClient } from "@qdrant/js-client-rest";

const log = getLogger(["yams", "qdrant"]);
const COLLECTION_NAME = "yams_memories";

let client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
	if (!client) {
		throw new Error("Qdrant not initialized - call initQdrant() first");
	}
	return client;
}

export async function initQdrant(dimensions?: number): Promise<void> {
	const url = process.env.QDRANT_URL ?? "http://localhost:6333";
	client = new QdrantClient({ url });

	const dims = dimensions ?? (Number(process.env.EMBEDDING_DIMENSIONS) || 768);

	const collections = await client.getCollections();
	const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

	if (!exists) {
		await client.createCollection(COLLECTION_NAME, {
			vectors: { size: dims, distance: "Cosine" },
		});
		log.info("Created collection {collection} ({dims} dimensions)", {
			collection: COLLECTION_NAME,
			dims,
		});
	}
}

export interface MemoryPayload {
	[key: string]: unknown;
	memory_id: string;
	user_id: string;
	git_remote: string | null;
	scope: string;
	api_key_label: string;
	created_at: string;
	expires_at: string | null;
}

export async function upsertMemory(
	id: string,
	vector: number[],
	payload: MemoryPayload,
): Promise<void> {
	const qdrant = getQdrantClient();
	await qdrant.upsert(COLLECTION_NAME, {
		points: [{ id, vector, payload }],
	});
}

export async function deletePoint(id: string): Promise<void> {
	const qdrant = getQdrantClient();
	await qdrant.delete(COLLECTION_NAME, { points: [id] });
}

export interface MemoryFilter {
	git_remote?: string;
	scope?: string;
	user_id?: string;
}

export async function searchMemories(vector: number[], filter?: MemoryFilter, limit = 10) {
	const qdrant = getQdrantClient();

	const must: Array<{ key: string; match: { value: string } }> = [];
	if (filter?.user_id) {
		must.push({ key: "user_id", match: { value: filter.user_id } });
	}
	if (filter?.git_remote) {
		must.push({ key: "git_remote", match: { value: filter.git_remote } });
	}
	if (filter?.scope) {
		must.push({ key: "scope", match: { value: filter.scope } });
	}

	return qdrant.search(COLLECTION_NAME, {
		vector,
		limit,
		filter: must.length > 0 ? { must } : undefined,
		with_payload: true,
	});
}

export function setQdrantClient(c: QdrantClient | null) {
	client = c;
}
