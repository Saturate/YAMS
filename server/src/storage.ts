import { getLogger } from "@logtape/logtape";

const log = getLogger(["husk", "storage"]);

// --- Types (moved from qdrant.ts) ---

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

export interface MemoryFilter {
	git_remote?: string;
	scope?: string;
	user_id?: string;
	workspace_id?: string;
}

export interface VectorSearchResult {
	id: string;
	score: number;
	payload: Record<string, unknown>;
}

// --- Interface ---

export interface StorageProvider {
	readonly name: string;
	init(dimensions: number): Promise<void>;
	upsert(id: string, vector: number[], payload: MemoryPayload): Promise<void>;
	search(vector: number[], filter?: MemoryFilter, limit?: number): Promise<VectorSearchResult[]>;
	delete(id: string): Promise<void>;
	healthy(): Promise<boolean>;
}

// --- Singleton + factory ---

let provider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
	if (!provider) {
		throw new Error("Storage not initialized — call initStorage() first");
	}
	return provider;
}

export function setStorageProvider(p: StorageProvider | null): void {
	provider = p;
}

export async function initStorage(dimensions: number): Promise<void> {
	const backend = process.env.HUSK_STORAGE ?? "qdrant";

	switch (backend) {
		case "sqlite-vec": {
			const { SqliteVecStorageProvider } = await import("./storage-sqlite-vec.js");
			provider = new SqliteVecStorageProvider();
			break;
		}
		default: {
			const { QdrantStorageProvider } = await import("./storage-qdrant.js");
			provider = new QdrantStorageProvider();
			break;
		}
	}

	await provider.init(dimensions);
	log.info("Storage ready ({name})", { name: provider.name });
}
