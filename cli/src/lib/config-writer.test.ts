import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { paths } from "./paths.js";
import {
	defaultConfig,
	writeConfig,
	readConfig,
	mergeConfig,
	resolveConfigPath,
} from "./config-writer.js";

describe("defaultConfig", () => {
	test("returns expected defaults", () => {
		const cfg = defaultConfig();
		expect(cfg.server?.port).toBe(3000);
		expect(cfg.storage?.backend).toBe("sqlite-vec");
		expect(cfg.embeddings?.backend).toBe("transformers");
	});

	test("paths point to exact expected locations", () => {
		const cfg = defaultConfig();
		expect(cfg.server?.db_path).toBe(paths.dbPath);
		expect(cfg.storage?.path).toBe(paths.vectorsPath);
		expect(cfg.embeddings?.models_path).toBe(paths.modelsPath);
	});

	test("does not include optional sections", () => {
		const cfg = defaultConfig();
		expect(cfg.compression).toBeUndefined();
		expect(cfg.auth).toBeUndefined();
	});
});

describe("writeConfig / readConfig", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "husk-cfg-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("round-trips through TOML with deep equality", () => {
		const configPath = join(dir, "husk.toml");
		const original = defaultConfig();
		writeConfig(original, configPath);

		const loaded = readConfig(configPath);
		expect(loaded).not.toBeNull();
		// Deep equality — catches any field being mangled by TOML serialization
		expect(loaded).toEqual(original);
	});

	test("round-trips custom config with all sections", () => {
		const configPath = join(dir, "full.toml");
		const config = {
			server: { port: 8080, db_path: "/tmp/test.db", jwt_secret: "s3cret" },
			storage: { backend: "qdrant", url: "http://localhost:6333" },
			embeddings: { backend: "openai", api_key: "sk-test", dimensions: 1536 },
			compression: { provider: "openai", model: "gpt-4o-mini" },
			auth: { github_client_id: "abc123" },
		};
		writeConfig(config, configPath);
		expect(readConfig(configPath)).toEqual(config);
	});

	test("readConfig returns null for missing file", () => {
		expect(readConfig(join(dir, "nope.toml"))).toBeNull();
	});

	test("readConfig returns null for corrupt TOML", () => {
		const configPath = join(dir, "bad.toml");
		writeFileSync(configPath, "[broken\nthis is not valid toml{{{");
		expect(readConfig(configPath)).toBeNull();
	});

	test("readConfig returns empty object for empty file", () => {
		const configPath = join(dir, "empty.toml");
		writeFileSync(configPath, "");
		const result = readConfig(configPath);
		expect(result).toEqual({});
	});

	test("readConfig parses valid TOML that doesn't match HuskConfig shape", () => {
		const configPath = join(dir, "weird.toml");
		writeFileSync(configPath, '[random]\nkey = "value"');
		const result = readConfig(configPath);
		// No runtime validation — returns whatever TOML parsed
		expect(result).toEqual({ random: { key: "value" } });
	});

	test("writeConfig creates parent directories", () => {
		const configPath = join(dir, "nested", "deep", "husk.toml");
		writeConfig(defaultConfig(), configPath);
		expect(existsSync(configPath)).toBe(true);
	});

	test("writeConfig strips undefined values via JSON round-trip", () => {
		const configPath = join(dir, "undefs.toml");
		const config = { server: { port: 3000, jwt_secret: undefined } };
		writeConfig(config, configPath);
		const loaded = readConfig(configPath);
		expect(loaded).toEqual({ server: { port: 3000 } });
	});
});

describe("mergeConfig", () => {
	test("shallow-merges sections correctly", () => {
		const base = defaultConfig();
		const overrides = { server: { port: 9000 } };
		const merged = mergeConfig(base, overrides);

		expect(merged.server?.port).toBe(9000);
		expect(merged.server?.db_path).toBe(base.server?.db_path);
	});

	test("doesn't clobber unrelated sections", () => {
		const base = defaultConfig();
		const overrides = {
			storage: { backend: "qdrant", url: "http://localhost:6333" },
		};
		const merged = mergeConfig(base, overrides);

		expect(merged.storage?.backend).toBe("qdrant");
		expect(merged.storage?.url).toBe("http://localhost:6333");
		expect(merged.embeddings).toEqual(base.embeddings);
		expect(merged.server).toEqual(base.server);
	});

	test("adds new sections", () => {
		const base = defaultConfig();
		const overrides = {
			compression: { provider: "openai", model: "gpt-4o-mini" },
		};
		const merged = mergeConfig(base, overrides);
		expect(merged.compression?.provider).toBe("openai");
		expect(merged.compression?.model).toBe("gpt-4o-mini");
	});

	test("empty overrides returns copy of base", () => {
		const base = defaultConfig();
		const merged = mergeConfig(base, {});
		expect(merged).toEqual(base);
		// Verify it's a copy, not the same reference
		expect(merged).not.toBe(base);
	});

	test("override with undefined value overwrites base (spread behavior)", () => {
		const base = { server: { port: 3000, db_path: "/data/husk.db" } };
		const overrides = { server: { port: 9000, db_path: undefined } };
		const merged = mergeConfig(base, overrides);
		// Spread behavior: undefined from overrides overwrites defined base value
		expect(merged.server?.db_path).toBeUndefined();
		expect(merged.server?.port).toBe(9000);
	});
});

describe("resolveConfigPath", () => {
	let dir: string;
	let originalCwd: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "husk-resolve-test-"));
		originalCwd = process.cwd();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	test("finds CWD husk.toml and returns absolute path", () => {
		writeFileSync(join(dir, "husk.toml"), "# local config");
		process.chdir(dir);
		const resolved = resolveConfigPath();
		expect(isAbsolute(resolved)).toBe(true);
		// Use realpathSync to normalize macOS /var → /private/var symlink
		expect(resolved).toBe(join(realpathSync(dir), "husk.toml"));
	});

	test("falls back to exact ~/.husk/husk.toml when no CWD config", () => {
		process.chdir(dir);
		const resolved = resolveConfigPath();
		expect(resolved).toBe(paths.config);
	});

	test("fallback path is absolute", () => {
		process.chdir(dir);
		const resolved = resolveConfigPath();
		expect(isAbsolute(resolved)).toBe(true);
	});
});
