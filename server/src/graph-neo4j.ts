import type {
	EdgeType,
	GraphEdge,
	GraphNeighbor,
	GraphProvider,
	TraversalResult,
} from "./graph.js";

export class Neo4jGraphProvider implements GraphProvider {
	readonly name = "neo4j";

	async init(): Promise<void> {
		const url = process.env.HUSK_GRAPH_URL ?? "bolt://localhost:7687";
		const user = process.env.HUSK_GRAPH_USER ?? "neo4j";
		const password = process.env.HUSK_GRAPH_PASSWORD;

		if (!password) {
			throw new Error(
				"HUSK_GRAPH_PASSWORD is required when using neo4j backend — set it in env or husk.toml [graph] password",
			);
		}

		let neo4j: typeof import("neo4j-driver");
		try {
			neo4j = await import("neo4j-driver");
		} catch {
			throw new Error(
				'neo4j-driver is not installed — run "bun add neo4j-driver" in the server directory',
			);
		}

		const driver = neo4j.default.driver(url, neo4j.default.auth.basic(user, password));
		const session = driver.session();
		try {
			await session.run("RETURN 1");
			await session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE");
			await session.run(
				"CREATE CONSTRAINT IF NOT EXISTS FOR ()-[e:EDGE]-() REQUIRE e.id IS UNIQUE",
			);
		} finally {
			await session.close();
			await driver.close();
		}
	}

	async addEdge(_params: {
		sourceMemoryId: string;
		targetMemoryId: string;
		edgeType: EdgeType;
		userId: string;
		metadata?: Record<string, unknown> | null;
	}): Promise<GraphEdge> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async getEdge(_edgeId: string): Promise<GraphEdge | null> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async removeEdge(_edgeId: string): Promise<boolean> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async removeEdgesForMemory(_memoryId: string): Promise<number> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async getNeighbors(
		_memoryId: string,
		_opts?: {
			edgeType?: EdgeType;
			direction?: "outgoing" | "incoming" | "both";
			limit?: number;
		},
	): Promise<GraphNeighbor[]> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async traverse(
		_memoryId: string,
		_opts?: {
			edgeTypes?: EdgeType[];
			maxDepth?: number;
			limit?: number;
		},
	): Promise<TraversalResult[]> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async getEdgesBetween(_memoryIdA: string, _memoryIdB: string): Promise<GraphEdge[]> {
		throw new Error("Neo4j graph provider not implemented");
	}

	async healthy(): Promise<boolean> {
		throw new Error("Neo4j graph provider not implemented");
	}
}
