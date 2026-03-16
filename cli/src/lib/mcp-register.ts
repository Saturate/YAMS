import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import * as p from "@clack/prompts";

interface McpConfig {
	mcpServers: Record<
		string,
		{ url: string; type?: string; headers?: Record<string, string> }
	>;
}

function hasClaudeCli(): boolean {
	try {
		execSync("which claude", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function hasCursor(): boolean {
	return existsSync(join(homedir(), ".cursor"));
}

export function detectClients(): { claude: boolean; cursor: boolean } {
	return {
		claude: hasClaudeCli(),
		cursor: hasCursor(),
	};
}

function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function registerClaude(serverUrl: string, apiKey: string): boolean {
	try {
		const base = stripTrailingSlash(serverUrl);
		const mcpJson = JSON.stringify({
			type: "http",
			url: `${base}/mcp`,
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		// Escape single quotes for safe shell interpolation
		const escaped = mcpJson.replace(/'/g, "'\\''");

		execSync(
			`claude mcp add-json husk '${escaped}' --scope user`,
			{ stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

export function registerCursor(serverUrl: string, apiKey: string): boolean {
	try {
		const base = stripTrailingSlash(serverUrl);
		const cursorDir = join(homedir(), ".cursor");
		const mcpPath = join(cursorDir, "mcp.json");

		let config: McpConfig = { mcpServers: {} };

		if (existsSync(mcpPath)) {
			try {
				config = JSON.parse(readFileSync(mcpPath, "utf-8"));
				if (!config.mcpServers || typeof config.mcpServers !== "object") {
					config.mcpServers = {};
				}
			} catch {
				// Corrupt file, overwrite
			}
		}

		config.mcpServers.husk = {
			url: `${base}/mcp`,
			headers: { Authorization: `Bearer ${apiKey}` },
		};

		mkdirSync(dirname(mcpPath), { recursive: true });
		writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
		return true;
	} catch {
		return false;
	}
}

export function getManualConfig(serverUrl: string, apiKey: string): string {
	const base = stripTrailingSlash(serverUrl);
	return JSON.stringify(
		{
			mcpServers: {
				husk: {
					type: "http",
					url: `${base}/mcp`,
					headers: { Authorization: `Bearer ${apiKey}` },
				},
			},
		},
		null,
		2,
	);
}

export async function registerClients(
	serverUrl: string,
	apiKey: string,
	clients?: string[],
): Promise<string[]> {
	const registered: string[] = [];

	const detected = detectClients();

	const targets =
		clients ??
		Object.entries(detected)
			.filter(([, v]) => v)
			.map(([k]) => k);

	for (const client of targets) {
		switch (client) {
			case "claude":
				if (registerClaude(serverUrl, apiKey)) {
					registered.push("Claude Code");
				} else {
					p.log.warning("Failed to register with Claude Code");
				}
				break;
			case "cursor":
				if (registerCursor(serverUrl, apiKey)) {
					registered.push("Cursor");
				} else {
					p.log.warning("Failed to register with Cursor");
				}
				break;
		}
	}

	return registered;
}
