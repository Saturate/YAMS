import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
import * as p from "@clack/prompts";
import { paths } from "./paths.js";

const LABEL = "io.husk.server";

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function launchdPlist(bunPath: string, configPath: string): string {
	const serverDir = `${paths.server}/server`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(bunPath)}</string>
		<string>run</string>
		<string>src/index.ts</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${escapeXml(serverDir)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HUSK_CONFIG</key>
		<string>${escapeXml(configPath)}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${paths.log}</string>
	<key>StandardErrorPath</key>
	<string>${paths.log}</string>
</dict>
</plist>`;
}

export function systemdUnit(bunPath: string, configPath: string): string {
	const serverDir = `${paths.server}/server`;
	return `[Unit]
Description=HUSK Memory Server

[Service]
ExecStart=${bunPath} run src/index.ts
WorkingDirectory=${serverDir}
Environment=HUSK_CONFIG=${configPath}
Restart=on-failure
StandardOutput=append:${paths.log}
StandardError=append:${paths.log}

[Install]
WantedBy=default.target`;
}

export function installService(bunPath: string, configPath: string): boolean {
	const os = platform();

	try {
		if (os === "darwin") {
			return installLaunchd(bunPath, configPath);
		}
		if (os === "linux") {
			return installSystemd(bunPath, configPath);
		}
		p.log.warning(
			`OS service not supported on ${os}. Use --foreground or manage the process manually.`,
		);
		return false;
	} catch (err) {
		p.log.warning(
			`Failed to install OS service: ${err instanceof Error ? err.message : err}`,
		);
		return false;
	}
}

function installLaunchd(bunPath: string, configPath: string): boolean {
	// Unload existing if present
	if (existsSync(paths.launchdPlist)) {
		try {
			execSync(`launchctl unload "${paths.launchdPlist}"`, {
				stdio: "pipe",
			});
		} catch {
			// Not loaded, fine
		}
	}

	mkdirSync(dirname(paths.launchdPlist), { recursive: true });
	writeFileSync(paths.launchdPlist, launchdPlist(bunPath, configPath));
	execSync(`launchctl load "${paths.launchdPlist}"`, { stdio: "pipe" });
	p.log.success("Installed launchd service (starts on boot)");
	return true;
}

function installSystemd(bunPath: string, configPath: string): boolean {
	mkdirSync(dirname(paths.systemdUnit), { recursive: true });
	writeFileSync(paths.systemdUnit, systemdUnit(bunPath, configPath));
	execSync("systemctl --user daemon-reload", { stdio: "pipe" });
	execSync("systemctl --user enable --now husk", { stdio: "pipe" });
	p.log.success("Installed systemd service (starts on boot)");
	return true;
}

export function uninstallService(): boolean {
	const os = platform();

	try {
		if (os === "darwin" && existsSync(paths.launchdPlist)) {
			execSync(`launchctl unload "${paths.launchdPlist}"`, {
				stdio: "pipe",
			});
			unlinkSync(paths.launchdPlist);
			return true;
		}
		if (os === "linux" && existsSync(paths.systemdUnit)) {
			execSync("systemctl --user stop husk", { stdio: "pipe" });
			execSync("systemctl --user disable husk", { stdio: "pipe" });
			unlinkSync(paths.systemdUnit);
			execSync("systemctl --user daemon-reload", { stdio: "pipe" });
			return true;
		}
	} catch {
		// Best effort
	}
	return false;
}

export function startService(): boolean {
	const os = platform();
	try {
		if (os === "darwin" && existsSync(paths.launchdPlist)) {
			execSync(`launchctl load "${paths.launchdPlist}"`, {
				stdio: "pipe",
			});
			return true;
		}
		if (os === "linux" && existsSync(paths.systemdUnit)) {
			execSync("systemctl --user start husk", { stdio: "pipe" });
			return true;
		}
	} catch {
		// Not installed
	}
	return false;
}

export function stopService(): boolean {
	const os = platform();
	try {
		if (os === "darwin" && existsSync(paths.launchdPlist)) {
			execSync(`launchctl unload "${paths.launchdPlist}"`, {
				stdio: "pipe",
			});
			return true;
		}
		if (os === "linux" && existsSync(paths.systemdUnit)) {
			execSync("systemctl --user stop husk", { stdio: "pipe" });
			return true;
		}
	} catch {
		// Not installed
	}
	return false;
}

export function hasService(): boolean {
	return existsSync(paths.launchdPlist) || existsSync(paths.systemdUnit);
}
