import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "./paths.js";

const home = homedir();

describe("paths", () => {
	test("home is ~/.husk", () => {
		expect(paths.home).toBe(join(home, ".husk"));
	});

	test("all data paths resolve to exact locations", () => {
		expect(paths.server).toBe(join(home, ".husk", "server"));
		expect(paths.data).toBe(join(home, ".husk", "data"));
		expect(paths.config).toBe(join(home, ".husk", "husk.toml"));
		expect(paths.credentials).toBe(join(home, ".husk", "credentials.json"));
		expect(paths.log).toBe(join(home, ".husk", "husk.log"));
		expect(paths.pid).toBe(join(home, ".husk", "husk.pid"));
		expect(paths.version).toBe(join(home, ".husk", "version.json"));
		expect(paths.modelsPath).toBe(join(home, ".husk", "data", "models"));
		expect(paths.dbPath).toBe(join(home, ".husk", "data", "husk.db"));
		expect(paths.vectorsPath).toBe(
			join(home, ".husk", "data", "husk-vectors.db"),
		);
	});

	test("launchd plist under ~/Library/LaunchAgents", () => {
		expect(paths.launchdPlist).toBe(
			join(home, "Library", "LaunchAgents", "io.husk.server.plist"),
		);
	});

	test("systemd unit under ~/.config/systemd/user", () => {
		expect(paths.systemdUnit).toBe(
			join(home, ".config", "systemd", "user", "husk.service"),
		);
	});

	test("no double slashes in any path", () => {
		for (const [key, value] of Object.entries(paths)) {
			expect(value).not.toContain("//");
		}
	});
});
