import { getLogger } from "@logtape/logtape";
import { deleteMemoriesBatch, getExpiredMemoryIds } from "./db.js";
import { deletePoint } from "./qdrant.js";

const log = getLogger(["yams", "retention"]);

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

	for (const id of ids) {
		try {
			await deletePoint(id);
		} catch (err) {
			log.warn("Qdrant delete failed for expired memory {id}: {error}", {
				id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	log.info("Swept {count} expired memories", { count: ids.length });

	// If batch was full, there might be more — schedule another pass
	if (ids.length === BATCH_SIZE) {
		const more = await sweepExpiredMemories();
		return ids.length + more;
	}

	return ids.length;
}
