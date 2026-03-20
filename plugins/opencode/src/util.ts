import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

interface HuskCredentials {
	url: string;
	apiKey: string;
}

/** Reads url + apiKey from ~/.husk/credentials.json (written by `husk init`) */
export function loadCredentials(): HuskCredentials | null {
	try {
		const raw = readFileSync(join(process.env.HUSK_HOME ?? join(homedir(), ".husk"), "credentials.json"), "utf-8");
		const data = JSON.parse(raw);
		if (typeof data.url === "string" && typeof data.apiKey === "string") {
			return { url: data.url, apiKey: data.apiKey };
		}
		return null;
	} catch {
		return null;
	}
}

/** Returns "owner/repo" from git remote origin, or null */
export function getGitRemote(cwd: string): string | null {
	try {
		const raw = execSync("git remote get-url origin", { cwd, encoding: "utf-8", timeout: 3000 }).trim();
		// Strip to owner/repo — handles both SSH and HTTPS URLs
		return raw.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "") || null;
	} catch {
		return null;
	}
}

/** Basename of the working directory, used as a human-friendly project name */
export function getProjectName(cwd: string): string {
	return basename(cwd) || "unknown";
}
