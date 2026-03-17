import { getLogger } from "@logtape/logtape";

const log = getLogger(["husk", "graph"]);

// --- Types ---

export const EDGE_TYPES = ["caused_by", "contradicts", "supersedes", "related_to"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface GraphEdge {
	id: string;
	source_memory_id: string;
	target_memory_id: string;
	edge_type: EdgeType;
	metadata: Record<string, unknown> | null;
	created_at: string;
	created_by: string;
}

export interface GraphNeighbor {
	memory_id: string;
	edge_id: string;
	edge_type: EdgeType;
	direction: "outgoing" | "incoming";
}

export interface TraversalResult {
	memory_id: string;
	depth: number;
	path: Array<{ edge_id: string; edge_type: EdgeType }>;
}

// --- Interface ---

export interface GraphProvider {
	readonly name: string;
	init(): Promise<void>;
	addEdge(params: {
		sourceMemoryId: string;
		targetMemoryId: string;
		edgeType: EdgeType;
		userId: string;
		metadata?: Record<string, unknown> | null;
	}): Promise<GraphEdge>;
	getEdge(edgeId: string): Promise<GraphEdge | null>;
	removeEdge(edgeId: string): Promise<boolean>;
	removeEdgesForMemory(memoryId: string): Promise<number>;
	getNeighbors(
		memoryId: string,
		opts?: {
			edgeType?: EdgeType;
			direction?: "outgoing" | "incoming" | "both";
			limit?: number;
		},
	): Promise<GraphNeighbor[]>;
	traverse(
		memoryId: string,
		opts?: {
			edgeTypes?: EdgeType[];
			maxDepth?: number;
			limit?: number;
		},
	): Promise<TraversalResult[]>;
	getEdgesBetween(memoryIdA: string, memoryIdB: string): Promise<GraphEdge[]>;
	healthy(): Promise<boolean>;
}

// --- Singleton + factory ---

let provider: GraphProvider | null = null;

export function getGraphProvider(): GraphProvider {
	if (!provider) {
		throw new Error("Graph not initialized — call initGraph() first");
	}
	return provider;
}

export function getGraphProviderOrNull(): GraphProvider | null {
	return provider;
}

export function setGraphProvider(p: GraphProvider | null): void {
	provider = p;
}

export async function initGraph(): Promise<void> {
	const backend = process.env.HUSK_GRAPH ?? "sqlite";

	if (backend === "none") {
		log.info("Graph layer disabled");
		return;
	}

	switch (backend) {
		case "neo4j": {
			const { Neo4jGraphProvider } = await import("./graph-neo4j.js");
			provider = new Neo4jGraphProvider();
			break;
		}
		default: {
			const { SqliteGraphProvider } = await import("./graph-sqlite.js");
			provider = new SqliteGraphProvider();
			break;
		}
	}

	await provider.init();
	log.info("Graph ready ({name})", { name: provider.name });
}
