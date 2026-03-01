import { getLogger } from "@logtape/logtape";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { ValidatedApiKey } from "./auth.js";
import { validateBearerKey } from "./auth.js";
import { parseSummary } from "./compression.js";
import {
	countMemories,
	countObservations,
	deleteMemory,
	getMemoryForUser,
	getObservationForUser,
	getRecentSessionSummaries,
	getSessionFilesModified,
	getSessionForUser,
	listDistinctGitRemotes,
	listMemories,
	listObservations,
} from "./db.js";
import { getProvider } from "./embeddings.js";
import { StoreMemoryError, isDuplicate, storeMemory } from "./ingest.js";
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

				const now = new Date().toISOString();
				let memories = results
					.filter((r) => {
						const expiresAt = r.payload?.expires_at;
						return !expiresAt || String(expiresAt) > now;
					})
					.map((r) => ({
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
			description:
				"Store a new memory. Checks for duplicates — if a similar memory exists, returns it instead of storing. Use force to skip the check, or replace to overwrite an existing memory. Cost: embedding call + vector search + DB write, no LLM.",
			inputSchema: {
				content: z.string().describe("The content to remember"),
				scope: z
					.enum(["session", "project", "global"])
					.optional()
					.describe("Memory scope (default: session)"),
				project: z.string().optional().describe("Git remote / project identifier"),
				force: z.boolean().optional().describe("Skip duplicate check and store anyway"),
				replace: z
					.string()
					.optional()
					.describe("ID of an existing memory to overwrite with new content"),
				ttl: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						"TTL in seconds. 0 or omitted = scope default (session: 30d, project: 90d, global: forever).",
					),
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
					force: args.force,
					replace: args.replace,
					ttl: args.ttl,
				});

				if (isDuplicate(result)) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(result, null, 2),
							},
						],
					};
				}

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
		"list_memories",
		{
			description:
				"List all memories, optionally filtered by project and/or scope. Returns full memory objects with IDs. Use for auditing, cleanup, or bulk review. Cost: DB read only, no LLM.",
			inputSchema: {
				project: z.string().optional().describe("Filter by git remote / project"),
				scope: z.enum(["session", "project", "global"]).optional().describe("Filter by scope"),
				limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
				offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
			},
		},
		(args) => {
			const limit = args.limit ?? 50;
			const offset = args.offset ?? 0;
			const memories = listMemories({
				gitRemote: args.project,
				scope: args.scope,
				limit,
				offset,
				userId: apiKey.user_id,
			});
			const total = countMemories({
				gitRemote: args.project,
				scope: args.scope,
				userId: apiKey.user_id,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ memories, total, limit, offset }, null, 2),
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

	server.registerTool(
		"get_observation",
		{
			description:
				"Get a single observation by ID with full content. Observation IDs are returned by get_session_detail. Cost: DB read only, no LLM.",
			inputSchema: {
				id: z.string().describe("The observation ID"),
			},
		},
		(args) => {
			const observation = getObservationForUser(args.id, apiKey.user_id);
			if (!observation) {
				return {
					content: [{ type: "text" as const, text: "Observation not found." }],
				};
			}

			let parsed: Record<string, unknown> = {};
			try {
				parsed = JSON.parse(observation.content);
			} catch {
				// raw content fallback
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								id: observation.id,
								session_id: observation.session_id,
								event: observation.event,
								tool_name: observation.tool_name,
								created_at: observation.created_at,
								prompt: observation.prompt ?? parsed.prompt ?? undefined,
								tool_input: parsed.tool_input ?? undefined,
								tool_response: parsed.tool_response ?? undefined,
								tool_input_summary: observation.tool_input_summary ?? undefined,
								files_modified: observation.files_modified
									? (() => {
											try {
												return JSON.parse(observation.files_modified);
											} catch {
												return undefined;
											}
										})()
									: undefined,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerPrompt(
		"meditate",
		{
			title: "Meditate",
			description:
				"Review and clean up your memories for a project or scope. Finds duplicates, contradictions, stale info, and overly verbose memories — then consolidates them.",
			argsSchema: {
				project: z.string().optional().describe("Git remote / project to focus on"),
				scope: z.enum(["session", "project", "global"]).optional().describe("Scope to review"),
			},
		},
		(args) => {
			const filters: string[] = [];
			if (args.project) filters.push(`project: ${args.project}`);
			if (args.scope) filters.push(`scope: ${args.scope}`);
			const filterDesc = filters.length > 0 ? filters.join(", ") : "all memories";

			return {
				messages: [
					{
						role: "user" as const,
						content: {
							type: "text" as const,
							text: `Review and clean up my YAMS memories (${filterDesc}). Follow these steps:

1. Use list_memories to fetch all memories${args.project ? ` for project "${args.project}"` : ""}${args.scope ? ` with scope "${args.scope}"` : ""}. Page through all results if there are more than the limit.

2. Analyze the memories and identify:
   - **Duplicates**: memories saying essentially the same thing
   - **Contradictions**: memories that conflict with each other (keep the newer one)
   - **Stale**: memories about things that are no longer true or relevant
   - **Verbose**: memories that could be said in fewer words without losing meaning

3. For each issue found, take action:
   - Duplicates → keep the best one, use forget to delete the others
   - Contradictions → keep the most recent, forget the outdated one
   - Stale → forget them
   - Verbose → use remember with replace to rewrite them more concisely

4. Give me a summary of what you did: how many memories before/after, what was removed/rewritten, and why.

Be conservative — when in doubt, keep the memory. Only remove things you're confident are duplicates or clearly stale.`,
						},
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
