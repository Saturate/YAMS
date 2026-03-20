import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { readCredentials } from "../lib/credentials.js";
import { banner } from "../lib/ui.js";

interface MemoryFile {
	path: string;
	name: string;
	type: string;
	description: string;
	content: string;
	project: string | null;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: raw };

	const meta: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	return { meta, body: match[2].trim() };
}

/** Extract project name from Claude memory path like -Users-alkj-code-github-PROJECTNAME */
function projectFromPath(memoryPath: string): string | null {
	const match = memoryPath.match(/-Users-[^/]+-code-(?:github-)?([^/]+)/);
	return match ? match[1] : null;
}

function discoverClaudeMemories(): MemoryFile[] {
	const claudeDir = join(homedir(), ".claude", "projects");
	const memories: MemoryFile[] = [];

	let projectDirs: string[];
	try {
		projectDirs = readdirSync(claudeDir);
	} catch {
		return memories;
	}

	for (const dir of projectDirs) {
		const memoryDir = join(claudeDir, dir, "memory");
		try {
			if (!statSync(memoryDir).isDirectory()) continue;
		} catch {
			continue;
		}

		const files = readdirSync(memoryDir).filter(
			(f) => f.endsWith(".md") && f !== "MEMORY.md",
		);

		for (const file of files) {
			const filePath = join(memoryDir, file);
			const raw = readFileSync(filePath, "utf-8");
			const { meta, body } = parseFrontmatter(raw);

			if (!body) continue;

			memories.push({
				path: filePath,
				name: meta.name ?? basename(file, ".md"),
				type: meta.type ?? "project",
				description: meta.description ?? "",
				content: body,
				project: projectFromPath(dir),
			});
		}
	}

	return memories;
}

function scopeFromType(type: string): "session" | "project" | "global" {
	if (type === "user" || type === "feedback") return "global";
	if (type === "reference") return "global";
	return "project";
}

export async function syncCommand() {
	banner();
	p.intro("Sync memories to HUSK");

	const creds = readCredentials();
	if (!creds) {
		p.log.error("No credentials found. Run `husk init` first.");
		process.exit(1);
	}

	// Check server health
	try {
		const res = await fetch(`${creds.url}/health`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		p.log.error(`Cannot reach HUSK at ${creds.url}`);
		process.exit(1);
	}

	const memories = discoverClaudeMemories();

	if (memories.length === 0) {
		p.log.info("No Claude Code memories found to sync.");
		p.outro("");
		return;
	}

	p.log.info(`Found ${memories.length} Claude Code memories`);

	for (const mem of memories) {
		const scope = scopeFromType(mem.type);
		const summary = mem.description
			? `${mem.name}: ${mem.description}`
			: mem.content.slice(0, 200);

		try {
			const res = await fetch(`${creds.url}/ingest`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${creds.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					summary: `${summary}\n\n${mem.content}`,
					scope,
					git_remote: null,
					metadata: {
						source: "claude-code",
						memory_type: mem.type,
						memory_name: mem.name,
						project: mem.project,
					},
				}),
			});

			if (res.ok) {
				p.log.success(`${mem.name} (${scope}${mem.project ? ` · ${mem.project}` : ""})`);
			} else {
				const err = (await res.json()) as { error?: string };
				p.log.error(`${mem.name}: ${err.error ?? res.statusText}`);
			}
		} catch (err) {
			p.log.error(`${mem.name}: ${err instanceof Error ? err.message : "failed"}`);
		}
	}

	p.outro(`Synced ${memories.length} memories to HUSK`);
}
