import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";

// TOML dotted key → env var name
const TOML_TO_ENV: Record<string, string> = {
	"server.port": "HUSK_PORT",
	"server.db_path": "HUSK_DB_PATH",
	"server.jwt_secret": "HUSK_JWT_SECRET",

	"storage.backend": "HUSK_STORAGE",
	"storage.url": "HUSK_STORAGE_URL",
	"storage.path": "HUSK_STORAGE_PATH",
	"storage.custom_sqlite": "HUSK_STORAGE_CUSTOM_SQLITE",

	"embeddings.backend": "HUSK_EMBEDDINGS",
	"embeddings.url": "HUSK_EMBED_URL",
	"embeddings.model": "HUSK_EMBED_MODEL",
	"embeddings.api_key": "HUSK_EMBED_API_KEY",
	"embeddings.dimensions": "HUSK_EMBED_DIMENSIONS",
	"embeddings.models_path": "HUSK_EMBED_MODELS_PATH",

	"compression.provider": "HUSK_COMPRESSION_PROVIDER",
	"compression.api_key": "HUSK_COMPRESSION_API_KEY",
	"compression.model": "HUSK_COMPRESSION_MODEL",
	"compression.url": "HUSK_COMPRESSION_URL",
	"compression.mode": "HUSK_COMPRESSION_MODE",

	"graph.backend": "HUSK_GRAPH",
	"graph.url": "HUSK_GRAPH_URL",
	"graph.user": "HUSK_GRAPH_USER",
	"graph.password": "HUSK_GRAPH_PASSWORD",

	"auth.github_client_id": "GITHUB_CLIENT_ID",
	"auth.github_client_secret": "GITHUB_CLIENT_SECRET",
	"auth.oauth_allowed_orgs": "OAUTH_ALLOWED_ORGS",
};

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const keys = path.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

export function loadConfig(path?: string): void {
	const configPath = path ?? process.env.HUSK_CONFIG ?? "husk.toml";

	if (!existsSync(configPath)) return;

	const raw = readFileSync(configPath, "utf-8");
	const parsed = parse(raw) as Record<string, unknown>;

	let applied = 0;
	for (const [tomlKey, envVar] of Object.entries(TOML_TO_ENV)) {
		if (process.env[envVar] !== undefined) continue;

		const value = getNestedValue(parsed, tomlKey);
		if (value === undefined || value === null) continue;

		process.env[envVar] = String(value);
		applied++;
	}

	if (applied > 0) {
		console.info(`Loaded ${applied} config value(s) from ${configPath}`);
	}
}
