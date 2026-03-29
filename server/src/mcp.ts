import { getLogger } from "@logtape/logtape";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { ValidatedApiKey } from "./auth.js";
import { validateBearerKey } from "./auth.js";
import { parseSummary } from "./compression.js";
import {
	UserScope,
	countObservations,
	getRecentSessionSummaries,
	getSessionFilesModified,
	getUserSetting,
	listObservations,
	markObservationsByIds,
	updateSessionSummary,
	validateObservationsBelongToSession,
} from "./db.js";
import { getProvider } from "./embeddings.js";
import { EDGE_TYPES, getGraphProviderOrNull } from "./graph.js";
import { StoreMemoryError, isDuplicate, storeMemory } from "./ingest.js";
import { getStorageProvider } from "./storage.js";
import { resolveWorkspace } from "./workspace.js";

const log = getLogger(["husk", "mcp"]);

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

function parseFilesModified(raw: string | null): string[] | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as string[];
	} catch {
		return undefined;
	}
}

function createMcpServer(apiKey: ValidatedApiKey): McpServer {
	const db = new UserScope(apiKey.user_id);
	const autoDetect = getUserSetting(apiKey.user_id, "workspace_auto_detect") !== "false";
	const wsOpts = { userId: apiKey.user_id, autoDetect };
	const server = new McpServer({
		name: "husk",
		version: "0.1.0",
	});

	server.registerTool(
		"search",
		{
			description:
				"Search memories by semantic similarity. When max_tokens is set, returns the most relevant memories that fit within the token budget — no need to guess a limit. Cost: embedding call + DB read, no LLM.",
			inputSchema: {
				query: z.string().describe("The search query"),
				scope: z
					.enum(["session", "project", "workspace", "global"])
					.optional()
					.describe("Filter by scope"),
				project: z.string().optional().describe("Filter by git remote / project"),
				workspace: z.string().optional().describe("Filter by workspace name or ID"),
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
				// Resolve workspace filter
				let workspaceId: string | undefined;
				if (args.workspace) {
					const ws = resolveWorkspace(args.workspace, wsOpts);
					workspaceId = ws?.id;
				} else if (args.scope === "workspace" && args.project) {
					const ws = resolveWorkspace(args.project, wsOpts);
					workspaceId = ws?.id;
				}

				// When token-budgeted, fetch generously and trim client-side
				const fetchLimit = args.max_tokens ? 50 : (args.limit ?? 10);
				const results = await getStorageProvider().search(
					vector,
					{
						git_remote: args.project,
						scope: args.scope,
						user_id: apiKey.user_id,
						workspace_id: workspaceId,
					},
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
					.enum(["session", "project", "workspace", "global"])
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
						"TTL in seconds. 0 or omitted = scope default (session: 30d, project/workspace: 90d, global: forever).",
					),
			},
		},
		async (args) => {
			try {
				// Resolve workspace when scope is "workspace"
				let workspaceId: string | null = null;
				if (args.scope === "workspace" && args.project) {
					const ws = resolveWorkspace(args.project, wsOpts);
					workspaceId = ws?.id ?? null;
				}

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
					workspaceId,
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
			if (!db.deleteMemory(args.id)) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Memory not found." }],
				};
			}

			try {
				await getStorageProvider().delete(args.id);
			} catch (err) {
				log.warn("Vector delete failed for {id}: {error}", {
					id: args.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			const graphProvider = getGraphProviderOrNull();
			if (graphProvider) {
				try {
					await graphProvider.removeEdgesForMemory(args.id);
				} catch (err) {
					log.warn("Graph edge cleanup failed for {id}: {error}", {
						id: args.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
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
			const projects = db.listGitRemotes();
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
				scope: z
					.enum(["session", "project", "workspace", "global"])
					.optional()
					.describe("Filter by scope"),
				limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
				offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
			},
		},
		(args) => {
			const limit = args.limit ?? 50;
			const offset = args.offset ?? 0;
			const memories = db.listMemories({
				gitRemote: args.project,
				scope: args.scope,
				limit,
				offset,
			});
			const total = db.countMemories({
				gitRemote: args.project,
				scope: args.scope,
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
			const session = db.getSession(args.session_id);
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
					return {
						id: o.id,
						event: o.event,
						tool_name: o.tool_name,
						created_at: o.created_at,
						prompt: o.prompt ?? undefined,
						tool_input_summary: o.tool_input_summary ?? undefined,
						files_modified: parseFilesModified(o.files_modified),
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
			const observation = db.getObservation(args.id);
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
								files_modified: parseFilesModified(observation.files_modified),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	// --- Client compression tools ---

	server.registerTool(
		"get_uncompressed_observations",
		{
			description:
				"Get uncompressed observations for a session. Used during client-side compression to read observations before summarizing them. Cost: DB read only, no LLM.",
			inputSchema: {
				session_id: z.string().describe("The session ID to get observations for"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Max observations to return (default 50, max 100)"),
			},
		},
		(args) => {
			const observations = db.getUncompressedObservations(args.session_id, args.limit);

			if (observations.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No uncompressed observations found." }],
				};
			}

			const formatted = observations.map((o) => ({
				id: o.id,
				event: o.event,
				tool_name: o.tool_name,
				prompt: o.prompt ?? undefined,
				tool_input_summary: o.tool_input_summary ?? undefined,
				files_modified: parseFilesModified(o.files_modified),
				created_at: o.created_at,
			}));

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
		"compress_observations",
		{
			description:
				"Mark observations as compressed and store their summary as a memory. Called after get_uncompressed_observations + LLM summarization. Cost: DB write + embedding + vector write, no LLM.",
			inputSchema: {
				observation_ids: z
					.array(z.string())
					.min(1)
					.max(100)
					.describe("IDs of observations to mark as compressed"),
				summary: z
					.string()
					.max(10000)
					.describe(
						"Structured summary of the observations (Request/Completed/Learned/Next Steps)",
					),
			},
		},
		async (args) => {
			// Validate ownership of all observation IDs
			if (!db.validateObservationIds(args.observation_ids)) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "One or more observation IDs not found or not owned by you.",
						},
					],
				};
			}

			// Verify all observations belong to the same session (min 1 guaranteed by schema)
			const [firstId] = args.observation_ids;
			const firstObs = firstId ? db.getObservation(firstId) : undefined;
			if (!firstObs) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Observation not found." }],
				};
			}

			const sessionId = firstObs.session_id;
			if (!validateObservationsBelongToSession(args.observation_ids, sessionId)) {
				return {
					isError: true,
					content: [
						{ type: "text" as const, text: "All observations must belong to the same session." },
					],
				};
			}

			const session = db.getSession(sessionId);
			if (!session) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Session not found." }],
				};
			}

			// Store summary as a session memory BEFORE marking observations,
			// so a storeMemory failure doesn't leave observations orphaned as "compressed"
			try {
				await storeMemory({
					summary: args.summary,
					apiKeyId: session.api_key_id,
					apiKeyLabel: "compression",
					userId: apiKey.user_id,
					gitRemote: session.project,
					scope: "session",
					metadata: { source: "client_compression", session_id: session.id },
					force: true,
				});
			} catch (err) {
				log.error("Failed to store compression memory: {error}", {
					error: err instanceof Error ? err.message : String(err),
				});
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Failed to store compression memory." }],
				};
			}

			// Mark observations only after the memory is safely stored
			const compressed = markObservationsByIds(args.observation_ids);

			// Update session summary
			updateSessionSummary(session.id, args.summary);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ compressed, memory_stored: true }, null, 2),
					},
				],
			};
		},
	);

	// --- Graph tools (only when graph layer is active) ---
	const graph = getGraphProviderOrNull();
	if (graph) {
		server.registerTool(
			"link",
			{
				description:
					"Create a typed edge between two memories. Edge types: caused_by (A was caused by B), contradicts (A conflicts with B), supersedes (A replaces B), related_to (general relation). Cost: DB write only, no LLM.",
				inputSchema: {
					source_id: z.string().describe("Source memory ID"),
					target_id: z.string().describe("Target memory ID"),
					edge_type: z.enum(EDGE_TYPES).describe("Relationship type"),
					metadata: z
						.record(z.string(), z.unknown())
						.optional()
						.describe("Optional metadata for the edge (max 4KB)")
						.refine(
							(v) => !v || JSON.stringify(v).length <= 4096,
							"Metadata must be under 4KB when serialized",
						),
				},
			},
			async (args) => {
				const source = db.getMemory(args.source_id);
				if (!source) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "Source memory not found." }],
					};
				}
				const target = db.getMemory(args.target_id);
				if (!target) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "Target memory not found." }],
					};
				}

				try {
					const edge = await graph.addEdge({
						sourceMemoryId: args.source_id,
						targetMemoryId: args.target_id,
						edgeType: args.edge_type,
						userId: apiKey.user_id,
						metadata: args.metadata,
					});
					return {
						content: [{ type: "text" as const, text: JSON.stringify(edge, null, 2) }],
					};
				} catch (err) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: err instanceof Error ? err.message : "Failed to create edge.",
							},
						],
					};
				}
			},
		);

		server.registerTool(
			"unlink",
			{
				description: "Remove an edge by its ID. Cost: DB write only, no LLM.",
				inputSchema: {
					edge_id: z.string().describe("The edge ID to remove"),
				},
			},
			async (args) => {
				const edge = await graph.getEdge(args.edge_id);
				if (!edge) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "Edge not found." }],
					};
				}

				// Verify caller owns at least one endpoint
				const ownsSource = db.getMemory(edge.source_memory_id);
				const ownsTarget = db.getMemory(edge.target_memory_id);
				if (!ownsSource && !ownsTarget) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "Edge not found." }],
					};
				}

				await graph.removeEdge(args.edge_id);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ edge_id: args.edge_id, removed: true }),
						},
					],
				};
			},
		);

		server.registerTool(
			"related",
			{
				description:
					"Find direct neighbors of a memory in the knowledge graph. Returns connected memories with edge types and directions. Cost: DB read only, no LLM.",
				inputSchema: {
					memory_id: z.string().describe("The memory ID to find neighbors for"),
					edge_type: z.enum(EDGE_TYPES).optional().describe("Filter by edge type"),
					direction: z
						.enum(["outgoing", "incoming", "both"])
						.optional()
						.describe("Filter by direction (default: both)"),
					limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
				},
			},
			async (args) => {
				const memory = db.getMemory(args.memory_id);
				if (!memory) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "Memory not found." }],
					};
				}

				const neighbors = await graph.getNeighbors(args.memory_id, {
					edgeType: args.edge_type,
					direction: args.direction,
					limit: args.limit ?? 20,
				});

				// Only return neighbors the caller owns
				const enriched = neighbors
					.map((n) => {
						const mem = db.getMemory(n.memory_id);
						if (!mem) return null;
						return { ...n, summary: mem.summary };
					})
					.filter((n) => n !== null);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(enriched, null, 2),
						},
					],
				};
			},
		);

		server.registerTool(
			"traverse",
			{
				description:
					"Walk the knowledge graph from a starting memory using BFS. Finds causal chains, contradiction clusters, and related memory groups. Cost: multiple DB reads, no LLM.",
				inputSchema: {
					memory_id: z.string().describe("Starting memory ID"),
					edge_types: z
						.array(z.enum(EDGE_TYPES))
						.optional()
						.describe("Only follow these edge types (default: all)"),
					max_depth: z
						.number()
						.int()
						.min(1)
						.max(5)
						.optional()
						.describe("Maximum traversal depth (default 3, max 5)"),
					limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
				},
			},
			async (args) => {
				const memory = db.getMemory(args.memory_id);
				if (!memory) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "Memory not found." }],
					};
				}

				const results = await graph.traverse(args.memory_id, {
					edgeTypes: args.edge_types,
					maxDepth: args.max_depth,
					limit: args.limit ?? 20,
				});

				// Only return nodes the caller owns
				const enriched = results
					.map((r) => {
						const mem = db.getMemory(r.memory_id);
						if (!mem) return null;
						return { ...r, summary: mem.summary };
					})
					.filter((r) => r !== null);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(enriched, null, 2),
						},
					],
				};
			},
		);
	}

	server.registerPrompt(
		"meditate",
		{
			title: "Meditate",
			description:
				"Review and clean up your memories for a project or scope. Finds duplicates, contradictions, stale info, and overly verbose memories — then consolidates them.",
			argsSchema: {
				project: z.string().optional().describe("Git remote / project to focus on"),
				scope: z
					.enum(["session", "project", "workspace", "global"])
					.optional()
					.describe("Scope to review"),
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
							text: `Review and clean up my HUSK memories (${filterDesc}). Follow these steps:

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

	server.registerPrompt(
		"compress_session",
		{
			title: "Compress Session",
			description:
				"Summarize accumulated observations for the current session. Reads uncompressed observations, writes a structured summary, and marks them as compressed.",
			argsSchema: {
				session_id: z.string().describe("The session ID to compress observations for"),
			},
		},
		(args) => {
			return {
				messages: [
					{
						role: "user" as const,
						content: {
							type: "text" as const,
							text: `Compress the uncompressed observations for session "${args.session_id}". Follow these steps:

1. Call get_uncompressed_observations with session_id "${args.session_id}" to fetch the pending observations.

2. Read through all observations and write a structured summary with these sections:

## Request
What the user asked to accomplish (1-2 sentences).

## Completed
What was actually done — name specific files, functions, patterns.

## Learned
Key decisions, constraints, or patterns discovered.

## Next Steps
Unfinished work or open questions.

3. Call compress_observations with the observation IDs from step 1 and your summary from step 2.

Be specific — this summary will restore context in future sessions.`,
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
