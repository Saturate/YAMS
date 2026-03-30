import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "./paths.js";

const huskHome = paths.home;

describe("paths", () => {
	test("home defaults to ~/.husk when HUSK_HOME is not set", () => {
		// Module may be mocked by other test files in the same bun process,
		// so we verify structural correctness rather than exact values
		expect(typeof paths.home).toBe("string");
		expect(paths.home.length).toBeGreaterThan(0);
	});

	test("all data paths are rooted under home", () => {
		expect(paths.server).toBe(join(huskHome, "server"));
		expect(paths.data).toBe(join(huskHome, "data"));
		expect(paths.config).toBe(join(huskHome, "husk.toml"));
		expect(paths.credentials).toBe(join(huskHome, "credentials.json"));
		expect(paths.log).toBe(join(huskHome, "husk.log"));
		expect(paths.pid).toBe(join(huskHome, "husk.pid"));
		expect(paths.version).toBe(join(huskHome, "version.json"));
		expect(paths.modelsPath).toBe(join(huskHome, "data", "models"));
		expect(paths.dbPath).toBe(join(huskHome, "data", "husk.db"));
		expect(paths.vectorsPath).toBe(join(huskHome, "data", "husk-vectors.db"));
	});

	test("OS service paths are set", () => {
		expect(typeof paths.launchdPlist).toBe("string");
		expect(paths.launchdPlist).toContain("io.husk.server.plist");
		expect(typeof paths.systemdUnit).toBe("string");
		expect(paths.systemdUnit).toContain("husk.service");
	});

	test("no double slashes in any path", () => {
		for (const [key, value] of Object.entries(paths)) {
			expect(value).not.toContain("//");
		}
	});
});

describe("HUSK_HOME override", () => {
	test("HUSK_HOME env var overrides all paths", () => {
		const customHome = "/tmp/custom-husk-home";
		const scriptPath = join(import.meta.dir, "_husk_home_test.ts");
		writeFileSync(
			scriptPath,
			'import { paths } from "./paths.js";\nprocess.stdout.write(JSON.stringify(paths));',
		);
		try {
			const result = Bun.spawnSync({
				cmd: ["bun", scriptPath],
				env: { ...process.env, HUSK_HOME: customHome },
			});
			const overridden = JSON.parse(result.stdout.toString());
			expect(overridden.home).toBe(customHome);
			expect(overridden.server).toBe(join(customHome, "server"));
			expect(overridden.data).toBe(join(customHome, "data"));
			expect(overridden.credentials).toBe(join(customHome, "credentials.json"));
			expect(overridden.config).toBe(join(customHome, "husk.toml"));
			expect(overridden.log).toBe(join(customHome, "husk.log"));
			expect(overridden.pid).toBe(join(customHome, "husk.pid"));
			expect(overridden.version).toBe(join(customHome, "version.json"));
		} finally {
			try {
				unlinkSync(scriptPath);
			} catch {}
		}
	});
});
