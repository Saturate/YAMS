import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock clack and ui before importing credentials
mock.module("@clack/prompts", () => ({
	intro: () => {},
	outro: () => {},
	cancel: () => {},
	note: () => {},
	text: () => Promise.resolve(""),
	select: () => Promise.resolve(""),
	spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
	log: { info: () => {}, success: () => {}, warning: () => {} },
	isCancel: () => false,
}));

mock.module("./ui.js", () => ({
	banner: () => {},
	handleCancel: () => {},
	isInteractive: () => true,
	withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

// Mock paths so tests don't touch real ~/.husk/
let tempDir: string;

mock.module("./paths.js", () => {
	tempDir = mkdtempSync(join(tmpdir(), "husk-cred-paths-"));
	return {
		paths: {
			home: tempDir,
			server: join(tempDir, "server"),
			data: join(tempDir, "data"),
			credentials: join(tempDir, "credentials.json"),
			config: join(tempDir, "husk.toml"),
			log: join(tempDir, "husk.log"),
			pid: join(tempDir, "husk.pid"),
			version: join(tempDir, "version.json"),
			modelsPath: join(tempDir, "data", "models"),
			dbPath: join(tempDir, "data", "husk.db"),
			vectorsPath: join(tempDir, "data", "husk-vectors.db"),
			launchdPlist: join(tempDir, "io.husk.server.plist"),
			systemdUnit: join(tempDir, "husk.service"),
		},
	};
});

const { isFirstRun, setupAdmin, readCredentials } = await import(
	"./credentials.js"
);

describe("isFirstRun", () => {
	test("returns true on 503", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(null, { status: 503 })),
		);
		try {
			expect(await isFirstRun("http://localhost:3000")).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("returns false on 200", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(null, { status: 200 })),
		);
		try {
			expect(await isFirstRun("http://localhost:3000")).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("returns false on 401", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(null, { status: 401 })),
		);
		try {
			expect(await isFirstRun("http://localhost:3000")).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("returns false on network error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED")));
		try {
			expect(await isFirstRun("http://localhost:3000")).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("readCredentials", () => {
	test("returns null when file doesn't exist", () => {
		expect(readCredentials()).toBeNull();
	});

	test("returns parsed credentials from disk", () => {
		const creds = { url: "http://localhost:3000", apiKey: "sk-test", username: "admin" };
		writeFileSync(join(tempDir, "credentials.json"), JSON.stringify(creds));
		const result = readCredentials();
		expect(result).toEqual(creds);
	});

	test("returns null for corrupt JSON", () => {
		writeFileSync(join(tempDir, "credentials.json"), "{not valid json!!!");
		expect(readCredentials()).toBeNull();
	});

	afterEach(() => {
		// Clean up credentials file between tests
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(join(tempDir, "credentials.json"));
		} catch {}
	});
});

describe("setupAdmin", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(join(tempDir, "credentials.json"));
		} catch {}
	});

	test("chains /setup → /auth/login → /api/keys correctly", async () => {
		const calls: string[] = [];

		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = url.toString();
			calls.push(urlStr);

			if (urlStr.endsWith("/setup")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), { status: 200 }),
				);
			}
			if (urlStr.endsWith("/api/auth/login")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: {
							"set-cookie":
								"husk_session=test-session-token; Path=/; HttpOnly",
						},
					}),
				);
			}
			if (urlStr.endsWith("/api/keys")) {
				return Promise.resolve(
					new Response(JSON.stringify({ key: "husk_test_key_123" }), {
						status: 200,
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		});

		const creds = await setupAdmin(
			"http://localhost:3000",
			"admin",
			"pass123",
		);

		expect(calls).toEqual([
			"http://localhost:3000/setup",
			"http://localhost:3000/api/auth/login",
			"http://localhost:3000/api/keys",
		]);
		expect(creds.url).toBe("http://localhost:3000");
		expect(creds.apiKey).toBe("husk_test_key_123");
		expect(creds.username).toBe("admin");
	});

	test("saves credentials to disk", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.endsWith("/setup")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), { status: 200 }),
				);
			}
			if (urlStr.endsWith("/api/auth/login")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: {
							"set-cookie": "husk_session=tok; Path=/; HttpOnly",
						},
					}),
				);
			}
			if (urlStr.endsWith("/api/keys")) {
				return Promise.resolve(
					new Response(JSON.stringify({ key: "husk_saved_key" }), {
						status: 200,
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		});

		await setupAdmin("http://localhost:3000", "admin", "pass");

		const saved = JSON.parse(
			readFileSync(join(tempDir, "credentials.json"), "utf-8"),
		);
		expect(saved.apiKey).toBe("husk_saved_key");
		expect(saved.url).toBe("http://localhost:3000");
		expect(saved.username).toBe("admin");
	});

	test("throws on failed /setup", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "Already configured" }), {
					status: 409,
				}),
			),
		);

		expect(
			setupAdmin("http://localhost:3000", "admin", "pass"),
		).rejects.toThrow("Already configured");
	});

	test("throws when login fails", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.endsWith("/setup")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), { status: 200 }),
				);
			}
			// Login returns 401
			return Promise.resolve(new Response(null, { status: 401 }));
		});

		expect(
			setupAdmin("http://localhost:3000", "admin", "pass"),
		).rejects.toThrow("Login failed");
	});

	test("throws when no session cookie in login response", async () => {
		globalThis.fetch = mock((url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.endsWith("/setup")) {
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), { status: 200 }),
				);
			}
			if (urlStr.endsWith("/api/auth/login")) {
				// 200 but no set-cookie header
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), { status: 200 }),
				);
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		});

		expect(
			setupAdmin("http://localhost:3000", "admin", "pass"),
		).rejects.toThrow("No session cookie");
	});

	test("throws when /setup returns non-JSON body", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Internal Server Error", { status: 500 })),
		);

		expect(
			setupAdmin("http://localhost:3000", "admin", "pass"),
		).rejects.toThrow();
	});
});
