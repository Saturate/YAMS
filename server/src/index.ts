import { getLogger } from "@logtape/logtape";
import { app } from "./app.js";
import { initCompressionListener, runCompressionCycle } from "./compression.js";
import { loadConfig } from "./config.js";
import { getUserCount, initDb } from "./db.js";
import { checkOllamaModel, getProvider } from "./embeddings.js";
import { initGraph } from "./graph.js";
import { initLogging } from "./logger.js";
import { initRetentionSweeper } from "./retention.js";
import { initStorage } from "./storage.js";

loadConfig();
await initLogging();

// sqlite-vec on macOS needs Homebrew SQLite — must happen before any Database is created
if (process.env.HUSK_STORAGE === "sqlite-vec") {
	const { ensureSqliteExtensionSupport } = await import("./storage-sqlite-vec.js");
	ensureSqliteExtensionSupport();
}

initDb();

const log = getLogger(["husk", "server"]);
const port = Number(process.env.HUSK_PORT) || 3000;
const userCount = getUserCount();

log.info("Starting on port {port}", { port });
if (userCount === 0) {
	log.info("No users found - visit http://localhost:{port}/setup to create an admin", { port });
} else {
	log.info("Ready ({userCount} user(s) configured)", { userCount });
}

initStorage(getProvider().dimensions)
	.then(() => log.info("Vector storage ready"))
	.catch((err: unknown) =>
		log.warn("Vector storage not available - ingest will fail until it's running: {error}", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);

initGraph().catch((err: unknown) =>
	log.warn("Graph layer not available: {error}", {
		error: err instanceof Error ? err.message : String(err),
	}),
);

if (getProvider().name === "ollama") {
	checkOllamaModel();
}
initCompressionListener();
initRetentionSweeper();
runCompressionCycle().catch((err: unknown) =>
	log.warn("Compression catch-up failed: {error}", {
		error: err instanceof Error ? err.message : String(err),
	}),
);

export default {
	port,
	fetch: app.fetch,
};
