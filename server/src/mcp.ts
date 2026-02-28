import { getLogger } from "@logtape/logtape";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { ValidatedApiKey } from "./auth.js";
import { validateBearerKey } from "./auth.js";
import { parseSummary } from "./compression.js";
import {
	countObservations,
	deleteMemory,
	getMemoryForUser,
	getRecentSessionSummaries,
	getSessionFilesModified,
	getSessionForUser,
	listDistinctGitRemotes,
	listObservations,
} from "./db.js";
import { getProvider } from "./embeddings.js";
import { StoreMemoryError, storeMemory } from "./ingest.js";
import { deletePoint, searchMemories } from "./qdrant.js";

const log = getLogger(["yams", "mcp"]);

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function fitTokenBudget<T>(memories: T[], maxTokens: number): T[] {
	const result: T[] = [];
	let used = 0;

	for (const memory of memories) {
		const text = JSON.stringify(memory);
		const cost = estimateTokens(text);
		if (used + cost > maxTokens && result.length > 0) break;
		result.push(memory);
		used += cost;
	}

	return result;
}

function createMcpServer(apiKey: ValidatedApiKey): McpServer {
	const server = new McpServer({
		name: "yams",
		version: "0.1.0",
	});

	server.registerTool(
		"search",
		{
			description:
				"Search memories by semantic similarity. When max_tokens is set, returns the most relevant memories that fit within the token budget — no need to guess a limit. Cost: embedding call + DB read, no LLM.",
			inputSchema: {
				query: z.string().describe("The search query"),
				scope: z.enum(["session", "project", "global"]).optional().describe("Filter by scope"),
				project: z.string().optional().describe("Filter by git remote / project"),
				limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
				max_tokens: z
					.number()
					.int()
					.min(1)
					.max(100_000)
					.optional()
					.describe("Token budget — returns memories until budget is exhausted. Overrides limit."),
			},
		},
		async (args) => {
			const provider = getProvider();
			let vector: number[];
			try {
				vector = await provider.embed(args.query);
			} catch (err) {
				if (err instanceof Error) log.error("Embed failed: {error}", { error: err.message });
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "Embedding service unavailable.",
						},
					],
				};
			}

			try {
				// When token-budgeted, fetch generously and trim client-side
				const fetchLimit = args.max_tokens ? 50 : (args.limit ?? 10);
				const results = await searchMemories(
					vector,
					{ git_remote: args.project, scope: args.scope, user_id: apiKey.user_id },
					fetchLimit,
				);

				let memories = results.map((r) => ({
					score: r.score,
					...(r.payload ?? {}),
				}));

				if (args.max_tokens) {
					memories = fitTokenBudget(memories, args.max_tokens);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(memories, null, 2),
						},
					],
				};
			} catch (err) {
				if (err instanceof Error) log.error("Search failed: {error}", { error: err.message });
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "Search service unavailable.",
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"remember",
		{
			description: "Store a new memory. Cost: embedding call + DB write, no LLM.",
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
					userId: apiKey.user_id,
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
				if (err instanceof Error) log.error("Store failed: {error}", { error: err.message });
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "Failed to store memory.",
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"forget",
		{
			description:
				"Delete a memory by ID. Use search first to find memory IDs. Cost: DB write + vector delete, no LLM.",
			inputSchema: {
				id: z.string().describe("The memory ID to delete (returned by search)"),
			},
		},
		async (args) => {
			const memory = getMemoryForUser(args.id, apiKey.user_id);
			if (!memory) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Memory not found." }],
				};
			}

			deleteMemory(args.id);

			try {
				await deletePoint(args.id);
			} catch (err) {
				log.warn("Qdrant delete failed for {id}: {error}", {
					id: args.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify({ id: args.id, deleted: true }) }],
			};
		},
	);

	server.registerTool(
		"list_projects",
		{
			description: "List known projects (distinct git remotes). Cost: DB read only, no LLM.",
		},
		() => {
			const projects = listDistinctGitRemotes(apiKey.user_id);
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

	server.registerTool(
		"session_context",
		{
			description:
				"List recent sessions as a compact index. Returns session IDs, dates, project, status, observation count, files modified, and a short summary preview. Use get_session_detail to fetch full details for interesting sessions. Cost: DB read only, no LLM.",
			inputSchema: {
				project: z.string().optional().describe("Filter by project (git remote or cwd)"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(20)
					.optional()
					.describe("Number of sessions to return (default 5)"),
			},
		},
		(args) => {
			const sessions = getRecentSessionSummaries({
				userId: apiKey.user_id,
				project: args.project,
				limit: args.limit ?? 5,
			});

			if (sessions.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No session summaries found.",
						},
					],
				};
			}

			const PREVIEW_LENGTH = 120;
			const formatted = sessions.map((s) => {
				const summary = s.summary ?? "";
				const filesModified = getSessionFilesModified(s.id);
				return {
					session_id: s.id,
					project: s.project,
					status: s.status,
					started_at: s.started_at,
					ended_at: s.ended_at,
					observation_count: countObservations(s.id),
					files_modified: filesModified.length > 0 ? filesModified : undefined,
					summary_preview:
						summary.length > PREVIEW_LENGTH ? `${summary.slice(0, PREVIEW_LENGTH)}...` : summary,
				};
			});

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(formatted, null, 2),
					},
				],
			};
		},
	);

	server.registerTool(
		"get_session_detail",
		{
			description:
				"Get full details for a specific session including the complete summary and all observations. Use session_context first to find relevant session IDs. Cost: DB read only, no LLM.",
			inputSchema: {
				session_id: z.string().describe("The session ID to retrieve"),
			},
		},
		(args) => {
			const session = getSessionForUser(args.session_id, apiKey.user_id);
			if (!session) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Session not found.",
						},
					],
				};
			}

			const filesModified = getSessionFilesModified(session.id);

			const observations = listObservations(session.id).map((o) => {
				// Use enriched columns when available, fall back to JSON parse
				if (o.prompt || o.tool_input_summary) {
					let parsedFiles: string[] | undefined;
					if (o.files_modified) {
						try {
							parsedFiles = JSON.parse(o.files_modified);
						} catch {
							/* malformed JSON — skip */
						}
					}
					return {
						id: o.id,
						event: o.event,
						tool_name: o.tool_name,
						created_at: o.created_at,
						prompt: o.prompt ?? undefined,
						tool_input_summary: o.tool_input_summary ?? undefined,
						files_modified: parsedFiles,
					};
				}

				// Pre-migration fallback: parse JSON content
				let parsed: Record<string, unknown> = {};
				try {
					parsed = JSON.parse(o.content);
				} catch {
					// raw content fallback
				}

				return {
					id: o.id,
					event: o.event,
					tool_name: o.tool_name,
					created_at: o.created_at,
					prompt: parsed.prompt ?? undefined,
					tool_input: parsed.tool_input ?? undefined,
					tool_response:
						typeof parsed.tool_response === "string"
							? parsed.tool_response.slice(0, 2000)
							: undefined,
				};
			});

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								session_id: session.id,
								project: session.project,
								status: session.status,
								summary: session.summary ? parseSummary(session.summary) : null,
								started_at: session.started_at,
								ended_at: session.ended_at,
								files_modified: filesModified.length > 0 ? filesModified : undefined,
								observations,
							},
							null,
							2,
						),
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
