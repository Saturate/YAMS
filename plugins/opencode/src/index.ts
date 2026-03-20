import { execSync } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";
import { checkHealth, postIngest } from "./husk-client.js";
import { getGitRemote, getProjectName, loadCredentials } from "./util.js";

// Per-session state — keyed by session ID to handle concurrent sessions
const sessions = new Map<string, Set<string>>();

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

			if (event.type === "session.deleted") {
				const sid = event.properties.info.id;
				await flushSession(sid, "ended");
			}

			if (event.type === "session.error") {
				const sid = event.properties.sessionID;
				if (sid) await flushSession(sid, "error");
			}
		},

		"shell.env": async (_input, output) => {
			if (url) output.env.HUSK_URL = url;
			if (key) output.env.HUSK_KEY = key;
		},
	};
};
