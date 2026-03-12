import { execSync, spawn, type ChildProcess } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { paths } from "./paths.js";
import { withSpinner } from "./ui.js";

const GITHUB_REPO = "Saturate/HUSK";

interface VersionInfo {
	version: string;
	downloadedAt: string;
}

export function isServerDownloaded(): boolean {
	return existsSync(join(paths.server, "server", "src", "index.ts"));
}

function readVersionInfo(): VersionInfo | null {
	try {
		return JSON.parse(readFileSync(paths.version, "utf-8"));
	} catch {
		return null;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function progressBar(ratio: number, width = 20): string {
	const clamped = Math.max(0, Math.min(1, ratio || 0));
	const filled = Math.round(clamped * width);
	return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

export async function downloadServer(ref = "main"): Promise<void> {
	const s = p.spinner();
	s.start("Downloading HUSK server...");

	try {
		mkdirSync(paths.server, { recursive: true });

		const tarballUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/${ref}.tar.gz`;
		const tarRes = await fetch(tarballUrl, { redirect: "follow" });

		if (!tarRes.ok || !tarRes.body) {
			throw new Error(`Failed to download from ${tarballUrl}: ${tarRes.status}`);
		}

		const totalBytes = Number(tarRes.headers.get("content-length")) || 0;
		const tarPath = join(paths.server, "husk.tar.gz");
		const fileStream = createWriteStream(tarPath);

		let received = 0;
		const reader = tarRes.body.getReader();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			fileStream.write(value);
			received += value.byteLength;

			if (totalBytes > 0) {
				const pct = Math.round((received / totalBytes) * 100);
				s.message(`Downloading HUSK server  ${progressBar(received / totalBytes)} ${pct}%  ${formatBytes(received)} / ${formatBytes(totalBytes)}`);
			} else {
				s.message(`Downloading HUSK server  ${formatBytes(received)}`);
			}
		}

		await new Promise<void>((resolve, reject) => {
			fileStream.end(() => resolve());
			fileStream.on("error", reject);
		});

		s.message("Extracting...");

		execSync("tar xzf husk.tar.gz --strip-components=1", {
			cwd: paths.server,
			stdio: "pipe",
		});
		unlinkSync(tarPath);

		const info: VersionInfo = {
			version: ref,
			downloadedAt: new Date().toISOString(),
		};
		writeFileSync(paths.version, JSON.stringify(info, null, 2));

		s.stop(`Downloaded HUSK server (${formatBytes(received)})`);
	} catch (error) {
		s.stop("Download failed");
		throw error;
	}
}

export async function installServerDeps(bunPath: string): Promise<void> {
	const serverDir = join(paths.server, "server");
	if (!existsSync(join(serverDir, "package.json"))) {
		throw new Error(
			`Server package.json not found at ${serverDir}. Download may have failed.`,
		);
	}

	await withSpinner("Installing server dependencies...", async () => {
		execSync(`${bunPath} install`, {
			cwd: serverDir,
			stdio: "pipe",
			env: { ...process.env, NODE_ENV: "production" },
		});
	});
}

export async function ensureServer(bunPath: string): Promise<void> {
	if (isServerDownloaded()) {
		const info = readVersionInfo();
		if (info) {
			p.log.success(`Server ${info.version} ready`);
		}
		return;
	}

	await downloadServer();
	await installServerDeps(bunPath);
	p.log.success("Server downloaded and ready");
}

export function startServerForeground(
	bunPath: string,
	configPath: string,
): ChildProcess {
	const serverDir = join(paths.server, "server");
	const child = spawn(bunPath, ["run", "src/index.ts"], {
		cwd: serverDir,
		stdio: "inherit",
		env: {
			...process.env,
			HUSK_CONFIG: configPath,
		},
	});
	return child;
}

export function startServerDaemon(
	bunPath: string,
	configPath: string,
): number {
	const serverDir = join(paths.server, "server");

	mkdirSync(paths.home, { recursive: true });

	const child = spawn(bunPath, ["run", "src/index.ts"], {
		cwd: serverDir,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		env: {
			...process.env,
			HUSK_CONFIG: configPath,
		},
	});

	// Pipe stdout/stderr to log file
	const logStream = createWriteStream(paths.log, { flags: "a" });
	child.stdout?.pipe(logStream);
	child.stderr?.pipe(logStream);

	child.unref();

	const pid = child.pid;
	if (pid) {
		writeFileSync(paths.pid, String(pid));
	}

	return pid ?? -1;
}

export async function waitForHealth(
	port: number,
	timeoutMs = 30000,
): Promise<boolean> {
	const start = Date.now();
	const url = `http://localhost:${port}/health`;

	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return true;
		} catch {
			// Server not ready yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

export function readPid(): number | null {
	try {
		const pid = parseInt(readFileSync(paths.pid, "utf-8").trim(), 10);
		return Number.isNaN(pid) ? null : pid;
	} catch {
		return null;
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function cleanPidFile(): void {
	try {
		unlinkSync(paths.pid);
	} catch {
		// ignore
	}
}
