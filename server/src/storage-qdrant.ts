import { getLogger } from "@logtape/logtape";
import { QdrantClient } from "@qdrant/js-client-rest";
import type {
	MemoryFilter,
	MemoryPayload,
	StorageProvider,
	VectorSearchResult,
} from "./storage.js";

const log = getLogger(["husk", "qdrant"]);
const COLLECTION_NAME = "husk_memories";

export class QdrantStorageProvider implements StorageProvider {
	readonly name = "qdrant";
	private client: QdrantClient | null = null;

	async init(dimensions: number): Promise<void> {
		const url = process.env.HUSK_STORAGE_URL ?? "http://localhost:6333";
		this.client = new QdrantClient({ url });

		const collections = await this.client.getCollections();
		const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

		if (!exists) {
			await this.client.createCollection(COLLECTION_NAME, {
				vectors: { size: dimensions, distance: "Cosine" },
			});
			log.info("Created collection {collection} ({dims} dimensions)", {
				collection: COLLECTION_NAME,
				dims: dimensions,
			});
		}
	}

	async upsert(id: string, vector: number[], payload: MemoryPayload): Promise<void> {
		const client = this.requireClient();
		await client.upsert(COLLECTION_NAME, {
			points: [{ id, vector, payload }],
		});
	}

	async search(vector: number[], filter?: MemoryFilter, limit = 10): Promise<VectorSearchResult[]> {
		const client = this.requireClient();

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
		if (filter?.workspace_id) {
			must.push({ key: "workspace_id", match: { value: filter.workspace_id } });
		}

		const results = await client.search(COLLECTION_NAME, {
			vector,
			limit,
			filter: must.length > 0 ? { must } : undefined,
			with_payload: true,
		});

		return results.map((r) => ({
			id: String(r.id),
			score: r.score,
			payload: (r.payload ?? {}) as Record<string, unknown>,
		}));
	}

	async delete(id: string): Promise<void> {
		const client = this.requireClient();
		await client.delete(COLLECTION_NAME, { points: [id] });
	}

	async healthy(): Promise<boolean> {
		if (!this.client) return false;
		try {
			await this.client.getCollections();
			return true;
		} catch {
			return false;
		}
	}

	private requireClient(): QdrantClient {
		if (!this.client) {
			throw new Error("Qdrant not initialized — call init() first");
		}
		return this.client;
	}
}
