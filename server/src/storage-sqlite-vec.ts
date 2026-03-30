import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "@logtape/logtape";
import * as sqliteVec from "sqlite-vec";
import type {
	MemoryFilter,
	MemoryPayload,
	StorageProvider,
	VectorSearchResult,
} from "./storage.js";

const log = getLogger(["husk", "storage-sqlite-vec"]);

/**
 * macOS ships Apple's SQLite with extension loading disabled.
 * Must be called BEFORE any Database instances are created (including db.ts).
 * No-op on Linux where extensions work out of the box.
 */
export function ensureSqliteExtensionSupport(): void {
	if (process.platform !== "darwin") return;

	const customPath = process.env.HUSK_STORAGE_CUSTOM_SQLITE;
	if (customPath) {
		try {
			Database.setCustomSQLite(customPath);
		} catch {
			// Already loaded — can happen if called late or in tests
		}
		return;
	}

	// Try common Homebrew paths
	const candidates = [
		"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon
		"/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel Mac
	];

	for (const path of candidates) {
		if (existsSync(path)) {
			try {
				Database.setCustomSQLite(path);
				log.info("Using Homebrew SQLite from {path}", { path });
			} catch {
				// Already loaded — extension loading may still work if the
				// bundled SQLite supports it (Linux), or fail gracefully at load time
			}
			return;
		}
	}

	log.warn(
		"macOS detected but Homebrew SQLite not found — sqlite-vec may fail. " +
			"Install with: brew install sqlite",
	);
}

// sqlite-vec returns results as { rowid: bigint | number, distance: number }
interface VecSearchRow {
	rowid: number | bigint;
	distance: number;
}

export class SqliteVecStorageProvider implements StorageProvider {
	readonly name = "sqlite-vec";
	private db: Database | null = null;
	private dimensions = 0;

	async init(dimensions: number): Promise<void> {
		this.dimensions = dimensions;
		const dbPath = process.env.HUSK_STORAGE_PATH ?? "data/husk-vectors.db";

		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}

		this.db = new Database(dbPath);
		this.db.run("PRAGMA journal_mode = WAL");

		try {
			sqliteVec.load(this.db);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to load sqlite-vec extension: ${msg}. ${
					process.platform === "darwin"
						? "On macOS, run: brew install sqlite"
						: "Ensure sqlite-vec native binaries are installed."
				}`,
			);
		}

		// Virtual table for vector search (KNN)
		this.db.run(
			`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[${dimensions}])`,
		);

		// Companion table for payloads (vec0 tables only store rowid + vector)
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory_payloads (
				id TEXT PRIMARY KEY,
				rowid_ref INTEGER NOT NULL,
				payload TEXT NOT NULL
			)
		`);

		// Monotonic rowid counter — vec0 requires integer rowids
		this.db.run(`
			CREATE TABLE IF NOT EXISTS vec_rowid_seq (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				next_rowid INTEGER NOT NULL DEFAULT 1
			)
		`);
		this.db.run("INSERT OR IGNORE INTO vec_rowid_seq (id, next_rowid) VALUES (1, 1)");

		log.info("sqlite-vec initialized ({dims} dimensions)", { dims: dimensions });
	}

	async upsert(id: string, vector: number[], payload: MemoryPayload): Promise<void> {
		const db = this.requireDb();

		// Check if this id already exists
		const existing = db.prepare("SELECT rowid_ref FROM memory_payloads WHERE id = ?").get(id) as {
			rowid_ref: number;
		} | null;

		if (existing) {
			// Update: delete old vector row, insert new one at same rowid
			db.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(existing.rowid_ref);
			db.prepare("INSERT INTO memory_vectors (rowid, embedding) VALUES (?, vec_f32(?))").run(
				existing.rowid_ref,
				new Float32Array(vector),
			);
			db.prepare("UPDATE memory_payloads SET payload = ? WHERE id = ?").run(
				JSON.stringify(payload),
				id,
			);
		} else {
			// Insert: allocate new rowid
			const rowid = this.nextRowid(db);
			db.prepare("INSERT INTO memory_vectors (rowid, embedding) VALUES (?, vec_f32(?))").run(
				rowid,
				new Float32Array(vector),
			);
			db.prepare("INSERT INTO memory_payloads (id, rowid_ref, payload) VALUES (?, ?, ?)").run(
				id,
				rowid,
				JSON.stringify(payload),
			);
		}
	}

	async search(vector: number[], filter?: MemoryFilter, limit = 10): Promise<VectorSearchResult[]> {
		const db = this.requireDb();
		const hasFilter = filter && Object.values(filter).some(Boolean);

		// Over-fetch when filtering since we'll discard non-matching rows
		const fetchLimit = hasFilter ? limit * 5 : limit;

		const rows = db
			.prepare(
				`SELECT rowid, distance
				 FROM memory_vectors
				 WHERE embedding MATCH ?
				 ORDER BY distance
				 LIMIT ?`,
			)
			.all(new Float32Array(vector), fetchLimit) as VecSearchRow[];

		if (rows.length === 0) return [];

		// Batch-fetch payloads for matched rowids
		const rowids = rows.map((r) => Number(r.rowid));
		const placeholders = rowids.map(() => "?").join(",");
		const payloadRows = db
			.prepare(
				`SELECT id, rowid_ref, payload FROM memory_payloads WHERE rowid_ref IN (${placeholders})`,
			)
			.all(...rowids) as Array<{ id: string; rowid_ref: number; payload: string }>;

		const payloadMap = new Map<number, { id: string; payload: Record<string, unknown> }>();
		for (const row of payloadRows) {
			payloadMap.set(row.rowid_ref, {
				id: row.id,
				payload: JSON.parse(row.payload) as Record<string, unknown>,
			});
		}

		// sqlite-vec returns distance (lower = closer), convert to similarity score (0..1)
		// cosine distance ranges 0..2, similarity = 1 - (distance / 2)
		const results: VectorSearchResult[] = [];
		for (const row of rows) {
			const entry = payloadMap.get(Number(row.rowid));
			if (!entry) continue;

			// Apply filter in JS
			if (hasFilter) {
				if (filter.user_id && entry.payload.user_id !== filter.user_id) continue;
				if (filter.git_remote && entry.payload.git_remote !== filter.git_remote) continue;
				if (filter.scope && entry.payload.scope !== filter.scope) continue;
				if (filter.workspace_id && entry.payload.workspace_id !== filter.workspace_id) continue;
			}

			results.push({
				id: entry.id,
				score: 1 - row.distance / 2,
				payload: entry.payload,
			});

			if (results.length >= limit) break;
		}

		return results;
	}

	async delete(id: string): Promise<void> {
		const db = this.requireDb();

		const existing = db.prepare("SELECT rowid_ref FROM memory_payloads WHERE id = ?").get(id) as {
			rowid_ref: number;
		} | null;

		if (existing) {
			db.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(existing.rowid_ref);
			db.prepare("DELETE FROM memory_payloads WHERE id = ?").run(id);
		}
	}

	async healthy(): Promise<boolean> {
		// SQLite is always available if we got past init
		return this.db !== null;
	}

	private nextRowid(db: Database): number {
		const row = db
			.prepare(
				"UPDATE vec_rowid_seq SET next_rowid = next_rowid + 1 RETURNING next_rowid - 1 AS rowid",
			)
			.get() as { rowid: number };
		return row.rowid;
	}

	private requireDb(): Database {
		if (!this.db) {
			throw new Error("sqlite-vec storage not initialized — call init() first");
		}
		return this.db;
	}
}
