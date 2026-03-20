import { execSync } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";
import { checkHealth, postIngest, postObservation } from "./husk-client.js";
import { getGitRemote, getProjectName, loadCredentials } from "./util.js";

// Per-session state — keyed by session ID to handle concurrent sessions
const sessions = new Map<string, Set<string>>();

// Tracks which sessions need compression injection (one-shot flag)
const needsCompression = new Set<string>();

const COMPRESSION_THRESHOLD = Number(process.env.HUSK_COMPRESSION_BATCH_SIZE ?? "20");

function tryAutoStart() {
	try {
		execSync("npx husk", { stdio: "ignore", timeout: 5000 });
	} catch {
		// best-effort
	}
}

export const HuskPlugin: Plugin = async ({ directory }) => {
	const cwd = directory;

	// Resolve credentials once: env vars > ~/.husk/credentials.json
	const creds = loadCredentials();
	const url = process.env.HUSK_URL ?? creds?.url;
	const key = process.env.HUSK_KEY ?? creds?.apiKey;

	/** Fire-and-forget observation POST; sets compression flag when threshold is hit. */
	async function sendObservation(
		sessionId: string,
		event: string,
		extra?: { tool_name?: string; prompt?: string; tool_input?: unknown; tool_response?: string },
	) {
		if (!url || !key) return;

		const resp = await postObservation(url, key, {
			session_id: sessionId,
			event,
			cwd,
			tool_name: extra?.tool_name ?? null,
			prompt: extra?.prompt ?? null,
			tool_input: extra?.tool_input ?? null,
			tool_response: extra?.tool_response?.slice(0, 2000) ?? null,
		});

		if (resp.uncompressed_count && resp.uncompressed_count >= COMPRESSION_THRESHOLD) {
			needsCompression.add(sessionId);
		}
	}

	async function flushSession(sessionId: string, reason: string) {
		if (!url || !key) return;

		const editedFiles = sessions.get(sessionId);

		try {
			await postIngest(url, key, {
				summary: `Coding session on ${getProjectName(cwd)} (${reason})`,
				git_remote: getGitRemote(cwd),
				scope: "session",
				metadata: {
					session_id: sessionId,
					reason,
					cwd,
					files_edited: editedFiles ? [...editedFiles] : [],
				},
			});
		} catch {
			// best-effort — never block the editor
		} finally {
			sessions.delete(sessionId);
			needsCompression.delete(sessionId);
		}
	}

	return {
		config: async (config) => {
			if (!url || !key) return;
			config.mcp ??= {};
			config.mcp.husk ??= {
				type: "remote",
				url: `${url}/mcp`,
				headers: { Authorization: `Bearer ${key}` },
			};
		},

		event: async ({ event }) => {
			if (event.type === "session.created") {
				const sid = event.properties.info.id;
				sessions.set(sid, new Set());

				if (!url) return;

				const healthy = await checkHealth(url);
				if (!healthy) tryAutoStart();
			}

			if (event.type === "file.edited") {
				const file = event.properties.file;
				// file.edited doesn't carry a session ID, so add to all active sessions
				for (const tracked of sessions.values()) {
					tracked.add(file);
				}
			}

			// Stream observations for user messages
			if (event.type === "message.updated") {
				const msg = event.properties.info as Record<string, unknown>;
				if (msg.role === "user") {
					// Find the active session — message events don't carry session ID directly
					for (const sid of sessions.keys()) {
						const parts = msg.parts as Array<{ type: string; text?: string }> | undefined;
						const prompt = parts
							?.filter((p) => p.type === "text" && typeof p.text === "string")
							.map((p) => p.text)
							.join("\n");
						sendObservation(sid, "UserPromptSubmit", { prompt }).catch(() => {});
					}
				}
			}

			if (event.type === "session.deleted") {
				const sid = event.properties.info.id;
				await flushSession(sid, "ended");
			}

			if (event.type === "session.error") {
				const sid = event.properties.sessionID;
				if (sid) await flushSession(sid, "error");
			}
		},

		// Stream observations for tool executions
		"tool.execute.after": async (input, output) => {
			sendObservation(input.sessionID, "PostToolUse", {
				tool_name: input.tool,
				tool_input: input.args,
				tool_response: typeof output.output === "string" ? output.output : undefined,
			}).catch(() => {});
		},

		// Inject compression prompt when threshold is hit
		"experimental.chat.system.transform": async (_input, output) => {
			for (const sid of needsCompression) {
				needsCompression.delete(sid);
				output.system.push(
					`HUSK has accumulated uncompressed observations for session ${sid}. Please use the compress_session prompt (session_id: ${sid}) to summarize them.`,
				);
				break;
			}
		},

		"shell.env": async (_input, output) => {
			if (url) output.env.HUSK_URL = url;
			if (key) output.env.HUSK_KEY = key;
		},
	};
};
