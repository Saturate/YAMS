import { getLogger } from "@logtape/logtape";
import {
	deleteMemoriesBatch,
	getConfigWithEnv,
	getExpiredMemoryIds,
	getSoftDeletedMemoryIds,
} from "./db.js";
import { getGraphProviderOrNull } from "./graph.js";
import { getStorageProvider } from "./storage.js";

const log = getLogger(["husk", "retention"]);

const SWEEP_INTERVAL_MS = 60 * 60_000; // 1 hour
const BATCH_SIZE = 100;

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function initRetentionSweeper(): void {
	sweepExpiredMemories().catch((err) => {
		log.error("Initial retention sweep failed: {error}", {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	sweepInterval = setInterval(() => {
		sweepExpiredMemories().catch((err) => {
			log.error("Retention sweep failed: {error}", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}, SWEEP_INTERVAL_MS);
}

export function stopRetentionSweeper(): void {
	if (sweepInterval) {
		clearInterval(sweepInterval);
		sweepInterval = null;
	}
}

export async function sweepExpiredMemories(): Promise<number> {
	const ids = getExpiredMemoryIds(BATCH_SIZE);
	if (ids.length === 0) return 0;

	deleteMemoriesBatch(ids);

	const graphProvider = getGraphProviderOrNull();

	for (const id of ids) {
		try {
			await getStorageProvider().delete(id);
		} catch (err) {
			log.warn("Vector delete failed for expired memory {id}: {error}", {
				id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (graphProvider) {
			try {
				await graphProvider.removeEdgesForMemory(id);
			} catch (err) {
				log.warn("Graph edge cleanup failed for expired memory {id}: {error}", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	log.info("Swept {count} expired memories", { count: ids.length });

	// If batch was full, there might be more — schedule another pass
	if (ids.length === BATCH_SIZE) {
		const more = await sweepExpiredMemories();
		return ids.length + more;
	}

	// Hard-purge soft-deleted memories past grace period
	const purged = await purgeSoftDeletedMemories();
	return ids.length + purged;
}

const DEFAULT_SOFT_DELETE_GRACE_DAYS = 30;

async function purgeSoftDeletedMemories(): Promise<number> {
	const graceDaysStr = getConfigWithEnv("soft_delete_grace_days", "HUSK_SOFT_DELETE_GRACE_DAYS");
	const graceDays = graceDaysStr
		? Math.max(Number(graceDaysStr), 1)
		: DEFAULT_SOFT_DELETE_GRACE_DAYS;

	const ids = getSoftDeletedMemoryIds(graceDays, BATCH_SIZE);
	if (ids.length === 0) return 0;

	deleteMemoriesBatch(ids);

	const graphProvider = getGraphProviderOrNull();

	for (const id of ids) {
		try {
			await getStorageProvider().delete(id);
		} catch (err) {
			log.warn("Vector delete failed for purged memory {id}: {error}", {
				id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (graphProvider) {
			try {
				await graphProvider.removeEdgesForMemory(id);
			} catch (err) {
				log.warn("Graph edge cleanup failed for purged memory {id}: {error}", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	log.info("Purged {count} soft-deleted memories (grace: {days}d)", {
		count: ids.length,
		days: graceDays,
	});

	if (ids.length === BATCH_SIZE) {
		const more = await purgeSoftDeletedMemories();
		return ids.length + more;
	}

	return ids.length;
}
