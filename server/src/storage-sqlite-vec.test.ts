import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { SqliteVecStorageProvider, ensureSqliteExtensionSupport } from "./storage-sqlite-vec.js";
import type { MemoryPayload } from "./storage.js";

// macOS needs Homebrew SQLite for extension loading — try to set it up,
// but it may fail if other test files already created Database instances.
ensureSqliteExtensionSupport();

// Probe whether sqlite-vec can actually load in this process.
// When running the full suite on macOS, other tests open Database instances first,
// which locks out setCustomSQLite and makes extension loading impossible.
// On Linux this always works.
let sqliteVecAvailable = false;
try {
	const probe = new Database(":memory:");
	const sqliteVec = await import("sqlite-vec");
	sqliteVec.load(probe);
	sqliteVecAvailable = true;
} catch {
	// Extension loading not available in this process — skip tests
}

const DIMS = 4;

function makePayload(overrides?: Partial<MemoryPayload>): MemoryPayload {
	return {
		memory_id: "test-id",
		user_id: "user-1",
		git_remote: null,
		scope: "session",
		api_key_label: "test",
		created_at: new Date().toISOString(),
		expires_at: null,
		...overrides,
	};
}

function makeVector(seed: number): number[] {
	return Array.from({ length: DIMS }, (_, i) => Math.sin(seed + i));
}

describe.if(sqliteVecAvailable)("SqliteVecStorageProvider", () => {
	let provider: SqliteVecStorageProvider;

	beforeEach(async () => {
		provider = new SqliteVecStorageProvider();
		process.env.HUSK_VEC_DB_PATH = ":memory:";
		await provider.init(DIMS);
	});

	test("healthy returns true after init", async () => {
		expect(await provider.healthy()).toBe(true);
	});

	test("upsert and search round-trip", async () => {
		const vector = makeVector(1);
		const payload = makePayload({ memory_id: "m1" });

		await provider.upsert("m1", vector, payload);

		const results = await provider.search(vector, undefined, 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("m1");
		expect(results[0]?.score).toBeGreaterThan(0.99);
		expect(results[0]?.payload.user_id).toBe("user-1");
	});

	test("upsert overwrites existing entry", async () => {
		const vector = makeVector(1);
		await provider.upsert("m1", vector, makePayload({ scope: "session" }));
		await provider.upsert("m1", vector, makePayload({ scope: "global" }));

		const results = await provider.search(vector, undefined, 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.payload.scope).toBe("global");
	});

	test("delete removes entry", async () => {
		const vector = makeVector(1);
		await provider.upsert("m1", vector, makePayload());

		await provider.delete("m1");

		const results = await provider.search(vector, undefined, 10);
		expect(results).toHaveLength(0);
	});

	test("delete is idempotent for nonexistent id", async () => {
		await provider.delete("nonexistent");
	});

	test("search returns results ordered by similarity", async () => {
		const queryVec = makeVector(1);
		await provider.upsert("close", makeVector(1.01), makePayload({ memory_id: "close" }));
		await provider.upsert("far", makeVector(100), makePayload({ memory_id: "far" }));

		const results = await provider.search(queryVec, undefined, 10);
		expect(results.length).toBeGreaterThanOrEqual(2);
		expect(results[0]?.id).toBe("close");
		expect(results[0]?.score).toBeGreaterThan(results[1]?.score);
	});

	test("search respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await provider.upsert(`m${i}`, makeVector(i), makePayload({ memory_id: `m${i}` }));
		}

		const results = await provider.search(makeVector(0), undefined, 2);
		expect(results).toHaveLength(2);
	});

	test("search filters by user_id", async () => {
		const vec = makeVector(1);
		await provider.upsert("u1", vec, makePayload({ user_id: "alice" }));
		await provider.upsert("u2", vec, makePayload({ user_id: "bob" }));

		const results = await provider.search(vec, { user_id: "alice" }, 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("u1");
	});

	test("search filters by scope", async () => {
		const vec = makeVector(1);
		await provider.upsert("s1", vec, makePayload({ scope: "session" }));
		await provider.upsert("s2", vec, makePayload({ scope: "global" }));

		const results = await provider.search(vec, { scope: "global" }, 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("s2");
	});

	test("search filters by git_remote", async () => {
		const vec = makeVector(1);
		await provider.upsert("r1", vec, makePayload({ git_remote: "github.com/a/b" }));
		await provider.upsert("r2", vec, makePayload({ git_remote: "github.com/c/d" }));
		await provider.upsert("r3", vec, makePayload({ git_remote: null }));

		const results = await provider.search(vec, { git_remote: "github.com/a/b" }, 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("r1");
	});

	test("search with combined filters", async () => {
		const vec = makeVector(1);
		await provider.upsert("hit", vec, makePayload({ user_id: "alice", scope: "project" }));
		await provider.upsert("miss1", vec, makePayload({ user_id: "alice", scope: "session" }));
		await provider.upsert("miss2", vec, makePayload({ user_id: "bob", scope: "project" }));

		const results = await provider.search(vec, { user_id: "alice", scope: "project" }, 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("hit");
	});

	test("search returns empty for no matches", async () => {
		const results = await provider.search(makeVector(1), undefined, 10);
		expect(results).toHaveLength(0);
	});
});
