import { getLogger } from "@logtape/logtape";
import { app } from "./app.js";
import { initCompressionListener, runCompressionCycle } from "./compression.js";
import { getUserCount, initDb } from "./db.js";
import { checkOllamaModel } from "./embeddings.js";
import { initLogging } from "./logger.js";
import { initQdrant } from "./qdrant.js";
import { initRetentionSweeper } from "./retention.js";

await initLogging();

initDb();

const log = getLogger(["yams", "server"]);
const port = Number(process.env.YAMS_PORT) || 3000;
const userCount = getUserCount();

log.info("Starting on port {port}", { port });
if (userCount === 0) {
	log.info("No users found - visit http://localhost:{port}/setup to create an admin", { port });
} else {
	log.info("Ready ({userCount} user(s) configured)", { userCount });
}

initQdrant()
	.then(() => log.info("Qdrant connected"))
	.catch((err: unknown) =>
		log.warn("Qdrant not available - ingest will fail until it's running: {error}", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);

checkOllamaModel();
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
