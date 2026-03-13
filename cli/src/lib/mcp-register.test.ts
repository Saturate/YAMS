import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getManualConfig } from "./mcp-register.js";

describe("getManualConfig", () => {
	test("returns valid JSON with correct URL and Bearer header", () => {
		const result = getManualConfig("http://localhost:3000", "sk-test-123");
		const parsed = JSON.parse(result);

		expect(parsed.mcpServers.husk.url).toBe("http://localhost:3000/mcp");
		expect(parsed.mcpServers.husk.headers.Authorization).toBe(
			"Bearer sk-test-123",
		);
	});

	test("includes type field for streamable HTTP", () => {
		const result = getManualConfig("http://localhost:3000", "sk-test");
		const parsed = JSON.parse(result);
		expect(parsed.mcpServers.husk.type).toBe("http");
	});

	test("strips trailing slash from serverUrl", () => {
		const result = getManualConfig("http://localhost:3000/", "sk-test");
		const parsed = JSON.parse(result);
		expect(parsed.mcpServers.husk.url).toBe("http://localhost:3000/mcp");
	});

	test("handles URL without trailing slash identically", () => {
		const a = JSON.parse(
			getManualConfig("http://localhost:3000", "sk-test"),
		);
		const b = JSON.parse(
			getManualConfig("http://localhost:3000/", "sk-test"),
		);
		expect(a).toEqual(b);
	});
});

describe("registerCursor", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "husk-mcp-test-"));
		mkdirSync(join(dir, ".cursor"), { recursive: true });

		// Mock homedir so registerCursor writes to our temp dir
		mock.module("node:os", () => ({
			homedir: () => dir,
		}));
	});

	afterEach(() => {
		mock.restore();
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates mcp.json with husk entry", async () => {
		const { registerCursor } = await import("./mcp-register.js");

		const result = registerCursor("http://localhost:3000", "sk-test");
		expect(result).toBe(true);

		const content = JSON.parse(
			readFileSync(join(dir, ".cursor", "mcp.json"), "utf-8"),
		);
		expect(content.mcpServers.husk.url).toBe("http://localhost:3000/mcp");
		expect(content.mcpServers.husk.headers.Authorization).toBe(
			"Bearer sk-test",
		);
	});

	test("merges without clobbering existing servers", async () => {
		const existing = {
			mcpServers: {
				other: { url: "http://other:8080/mcp" },
			},
		};
		writeFileSync(
			join(dir, ".cursor", "mcp.json"),
			JSON.stringify(existing, null, 2),
		);

		const { registerCursor } = await import("./mcp-register.js");
		registerCursor("http://localhost:3000", "sk-test");

		const content = JSON.parse(
			readFileSync(join(dir, ".cursor", "mcp.json"), "utf-8"),
		);
		expect(content.mcpServers.other.url).toBe("http://other:8080/mcp");
		expect(content.mcpServers.husk.url).toBe("http://localhost:3000/mcp");
	});

	test("overwrites corrupt mcp.json gracefully", async () => {
		writeFileSync(join(dir, ".cursor", "mcp.json"), "{not valid json!!!");

		const { registerCursor } = await import("./mcp-register.js");
		const result = registerCursor("http://localhost:3000", "sk-test");
		expect(result).toBe(true);

		const content = JSON.parse(
			readFileSync(join(dir, ".cursor", "mcp.json"), "utf-8"),
		);
		expect(content.mcpServers.husk.url).toBe("http://localhost:3000/mcp");
	});

	test("handles mcp.json with null mcpServers", async () => {
		writeFileSync(
			join(dir, ".cursor", "mcp.json"),
			JSON.stringify({ mcpServers: null }),
		);

		const { registerCursor } = await import("./mcp-register.js");
		const result = registerCursor("http://localhost:3000", "sk-test");
		expect(result).toBe(true);

		const content = JSON.parse(
			readFileSync(join(dir, ".cursor", "mcp.json"), "utf-8"),
		);
		expect(content.mcpServers.husk).toBeDefined();
	});

	test("strips trailing slash from serverUrl", async () => {
		const { registerCursor } = await import("./mcp-register.js");
		registerCursor("http://localhost:3000/", "sk-test");

		const content = JSON.parse(
			readFileSync(join(dir, ".cursor", "mcp.json"), "utf-8"),
		);
		expect(content.mcpServers.husk.url).toBe("http://localhost:3000/mcp");
	});
});
