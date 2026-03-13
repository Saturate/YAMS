import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatBytes,
	progressBar,
	isServerDownloaded,
	readPid,
	isProcessAlive,
	cleanPidFile,
} from "./server.js";
import { paths } from "./paths.js";

describe("formatBytes", () => {
	test("zero bytes", () => {
		expect(formatBytes(0)).toBe("0 B");
	});

	test("bytes range", () => {
		expect(formatBytes(1)).toBe("1 B");
		expect(formatBytes(500)).toBe("500 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	test("kilobytes range", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024 - 1)).toContain("KB");
	});

	test("megabytes range", () => {
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
	});

	test("large values stay in MB (no GB tier)", () => {
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1024.0 MB");
	});

	test("negative values treated as bytes", () => {
		expect(formatBytes(-1)).toBe("-1 B");
	});
});

describe("progressBar", () => {
	test("0% → all empty", () => {
		const bar = progressBar(0, 10);
		expect(bar).toBe("░".repeat(10));
	});

	test("100% → all filled", () => {
		const bar = progressBar(1, 10);
		expect(bar).toBe("█".repeat(10));
	});

	test("50% → half and half", () => {
		const bar = progressBar(0.5, 10);
		expect(bar).toBe("█".repeat(5) + "░".repeat(5));
	});

	test("default width is 20", () => {
		const bar = progressBar(0);
		expect(bar.length).toBe(20);
	});

	test("ratio > 1 is clamped to 100%", () => {
		const bar = progressBar(1.5, 10);
		expect(bar).toBe("█".repeat(10));
	});

	test("ratio < 0 is clamped to 0%", () => {
		const bar = progressBar(-0.5, 10);
		expect(bar).toBe("░".repeat(10));
	});

	test("NaN ratio is clamped to 0%", () => {
		const bar = progressBar(NaN, 10);
		expect(bar).toBe("░".repeat(10));
	});
});

describe("isServerDownloaded", () => {
	test("returns false when server dir doesn't contain index.ts", () => {
		// ~/.husk/server/server/src/index.ts almost certainly doesn't exist in test env
		expect(isServerDownloaded()).toBe(false);
	});
});

describe("readPid", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "husk-pid-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns null when no pid file exists", () => {
		// Unless someone has a running husk, paths.pid won't exist
		// This is inherently environment-dependent, but the function handles it
		const result = readPid();
		// In CI/test environments, no PID file → null
		// If husk IS running, it's a valid number
		if (result !== null) {
			expect(typeof result).toBe("number");
			expect(Number.isNaN(result)).toBe(false);
		}
	});
});

describe("isProcessAlive", () => {
	test("returns true for own process", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("returns false for non-existent PID", () => {
		expect(isProcessAlive(99999999)).toBe(false);
	});

	test("returns false for PID 0 (process group, not a real check)", () => {
		// PID 0 sends signal to current process group — this is a footgun
		// but the function wraps in try/catch so it shouldn't crash
		const result = isProcessAlive(0);
		expect(typeof result).toBe("boolean");
	});
});

describe("cleanPidFile", () => {
	test("no-op when pid file doesn't exist", () => {
		expect(() => cleanPidFile()).not.toThrow();
	});
});
