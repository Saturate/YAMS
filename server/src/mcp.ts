import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { ValidatedApiKey } from "./auth.js";
import { validateBearerKey } from "./auth.js";
import { listDistinctGitRemotes } from "./db.js";
import { getProvider } from "./embeddings.js";
import { StoreMemoryError, storeMemory } from "./ingest.js";
import { searchMemories } from "./qdrant.js";

function createMcpServer(apiKey: ValidatedApiKey): McpServer {
	const server = new McpServer({
		name: "yams",
		version: "0.1.0",
	});

	server.registerTool(
		"search",
		{
			description: "Search memories by semantic similarity",
			inputSchema: {
				query: z.string().describe("The search query"),
				scope: z.enum(["session", "project", "global"]).optional().describe("Filter by scope"),
				project: z.string().optional().describe("Filter by git remote / project"),
				limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
			},
		},
		async (args) => {
			const provider = getProvider();
			let vector: number[];
			try {
				vector = await provider.embed(args.query);
			} catch (err) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Embedding error: ${err instanceof Error ? err.message : "Unknown error"}`,
						},
					],
				};
			}

			try {
				const results = await searchMemories(
					vector,
					{ git_remote: args.project, scope: args.scope },
					args.limit ?? 10,
				);

				const memories = results.map((r) => ({
					score: r.score,
					...(r.payload as Record<string, unknown>),
				}));

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(memories, null, 2),
						},
					],
				};
			} catch (err) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Search error: ${err instanceof Error ? err.message : "Unknown error"}`,
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"remember",
		{
			description: "Store a new memory",
			inputSchema: {
				content: z.string().describe("The content to remember"),
				scope: z
					.enum(["session", "project", "global"])
					.optional()
					.describe("Memory scope (default: session)"),
				project: z.string().optional().describe("Git remote / project identifier"),
			},
		},
		async (args) => {
			try {
				const result = await storeMemory({
					summary: args.content,
					apiKeyId: apiKey.id,
					apiKeyLabel: apiKey.label,
					gitRemote: args.project,
					scope: args.scope,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ stored: true, ...result }, null, 2),
						},
					],
				};
			} catch (err) {
				if (err instanceof StoreMemoryError) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: err.message,
							},
						],
					};
				}
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Failed to store memory: ${err instanceof Error ? err.message : "Unknown error"}`,
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"list_projects",
		{
			description: "List known projects (distinct git remotes)",
		},
		() => {
			const projects = listDistinctGitRemotes();
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ projects }, null, 2),
					},
				],
			};
		},
	);

	return server;
}

export function mountMcp(app: Hono) {
	app.all("/mcp", async (c) => {
		const result = await validateBearerKey(c.req.header("Authorization"));
		if ("error" in result) {
			return c.json({ error: result.error }, 401);
		}

		const server = createMcpServer(result.key);
		const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
		await server.connect(transport);

		try {
			return await transport.handleRequest(c.req.raw);
		} finally {
			await transport.close();
			await server.close();
		}
	});
}
