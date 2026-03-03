import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
	let dir: string;
	const savedEnv: Record<string, string | undefined> = {};

	// Track env vars we set so we can clean them up
	const envVarsToClean = [
		"HUSK_PORT",
		"HUSK_DB_PATH",
		"HUSK_STORAGE",
		"HUSK_STORAGE_URL",
		"HUSK_EMBED_URL",
		"HUSK_EMBED_MODEL",
		"HUSK_EMBED_API_KEY",
		"HUSK_EMBED_DIMENSIONS",
		"HUSK_EMBEDDINGS",
		"HUSK_COMPRESSION_PROVIDER",
		"GITHUB_CLIENT_ID",
	];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "husk-config-test-"));
		for (const key of envVarsToClean) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of envVarsToClean) {
			if (savedEnv[key] !== undefined) {
				process.env[key] = savedEnv[key];
			} else {
				delete process.env[key];
			}
		}
		rmSync(dir, { recursive: true, force: true });
	});

	test("populates process.env from TOML", () => {
		const toml = `
[server]
port = 4000

[storage]
backend = "sqlite-vec"
url = "http://qdrant:6333"

[embeddings]
backend = "voyage"
model = "voyage-3"
api_key = "sk-test"
dimensions = 512
`;
		const path = join(dir, "husk.toml");
		writeFileSync(path, toml);

		loadConfig(path);

		expect(process.env.HUSK_PORT).toBe("4000");
		expect(process.env.HUSK_STORAGE).toBe("sqlite-vec");
		expect(process.env.HUSK_STORAGE_URL).toBe("http://qdrant:6333");
		expect(process.env.HUSK_EMBEDDINGS).toBe("voyage");
		expect(process.env.HUSK_EMBED_MODEL).toBe("voyage-3");
		expect(process.env.HUSK_EMBED_API_KEY).toBe("sk-test");
		expect(process.env.HUSK_EMBED_DIMENSIONS).toBe("512");
	});

	test("env vars already set are NOT overridden", () => {
		process.env.HUSK_PORT = "5000";

		const toml = `
[server]
port = 4000
`;
		const path = join(dir, "husk.toml");
		writeFileSync(path, toml);

		loadConfig(path);

		expect(process.env.HUSK_PORT).toBe("5000");
	});

	test("missing file is a no-op", () => {
		const path = join(dir, "nonexistent.toml");
		expect(() => loadConfig(path)).not.toThrow();
	});

	test("invalid TOML throws a parse error", () => {
		const path = join(dir, "bad.toml");
		writeFileSync(path, "[invalid\ngarbage =");
		expect(() => loadConfig(path)).toThrow();
	});

	test("maps auth section to non-HUSK env vars", () => {
		const toml = `
[auth]
github_client_id = "id-123"
`;
		const path = join(dir, "husk.toml");
		writeFileSync(path, toml);

		loadConfig(path);

		expect(process.env.GITHUB_CLIENT_ID).toBe("id-123");
	});

	test("unknown TOML keys are silently ignored", () => {
		const toml = `
[embeddings]
foo = "bar"
backend = "ollama"
`;
		const path = join(dir, "husk.toml");
		writeFileSync(path, toml);

		expect(() => loadConfig(path)).not.toThrow();
		expect(process.env.HUSK_EMBEDDINGS).toBe("ollama");
	});

	test("ignores undefined TOML keys", () => {
		const toml = `
[server]
# only port set, db_path omitted
port = 3001
`;
		const path = join(dir, "husk.toml");
		writeFileSync(path, toml);

		loadConfig(path);

		expect(process.env.HUSK_PORT).toBe("3001");
		expect(process.env.HUSK_DB_PATH).toBeUndefined();
	});
});
