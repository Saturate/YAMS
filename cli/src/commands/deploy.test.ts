import { describe, expect, mock, test } from "bun:test";

// Mock clack and ui before importing deploy
mock.module("@clack/prompts", () => ({
	intro: () => {},
	log: { info: () => {}, success: () => {}, warning: () => {} },
	text: () => Promise.resolve(""),
	select: () => Promise.resolve(""),
	spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
	note: () => {},
	outro: () => {},
	cancel: () => {},
	isCancel: () => false,
}));

mock.module("../lib/ui.js", () => ({
	banner: () => {},
	handleCancel: () => {},
	isInteractive: () => true,
	withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { generatePrompt } = await import("./deploy.js");

const base = {
	domain: "husk.example.com",
	provider: "vps",
	proxy: "caddy",
	storage: "sqlite-vec",
	embeddings: "transformers",
};

describe("generatePrompt", () => {
	test("output includes domain in setup and checklist", () => {
		const output = generatePrompt(base);
		// Domain appears in setup section and DNS/verification sections
		const domainCount = output.split("husk.example.com").length - 1;
		expect(domainCount).toBeGreaterThanOrEqual(3);
	});

	test("output includes proxy name", () => {
		const output = generatePrompt(base);
		expect(output).toContain("Caddy");
	});

	test("output includes storage and embeddings", () => {
		const output = generatePrompt(base);
		expect(output).toContain("sqlite-vec");
		expect(output).toContain("transformers");
	});

	test("caddy → includes Caddyfile example with reverse_proxy", () => {
		const output = generatePrompt({ ...base, proxy: "caddy" });
		expect(output).toContain("## Example Caddy config");
		expect(output).toContain("reverse_proxy localhost:3000");
		expect(output).toContain("Caddy handles TLS automatically");
	});

	test("nginx → includes nginx server block with certbot", () => {
		const output = generatePrompt({ ...base, proxy: "nginx" });
		expect(output).toContain("## Example nginx config");
		expect(output).toContain("server_name husk.example.com");
		expect(output).toContain("proxy_pass http://localhost:3000");
		expect(output).toContain("certbot --nginx -d husk.example.com");
	});

	test("traefik → no proxy config examples", () => {
		const output = generatePrompt({ ...base, proxy: "traefik" });
		expect(output).toContain("Traefik");
		expect(output).not.toContain("## Example Caddy");
		expect(output).not.toContain("## Example nginx");
		expect(output).not.toContain("reverse_proxy");
		expect(output).not.toContain("proxy_pass");
	});

	test("no proxy → TLS termination section, no examples", () => {
		const output = generatePrompt({ ...base, proxy: "none" });
		expect(output).not.toContain("## Example Caddy");
		expect(output).not.toContain("## Example nginx");
		expect(output).toContain("I'll handle TLS");
		expect(output).toContain("Set up TLS termination");
	});

	test("qdrant storage → additional services in setup", () => {
		const output = generatePrompt({ ...base, storage: "qdrant" });
		expect(output).toContain("Qdrant (vector database)");
		expect(output).toContain("Additional services");
	});

	test("ollama embeddings → additional services in setup", () => {
		const output = generatePrompt({ ...base, embeddings: "ollama" });
		expect(output).toContain("Ollama (embedding model)");
		expect(output).toContain("Additional services");
	});

	test("sqlite-vec + transformers → no additional services line", () => {
		const output = generatePrompt(base);
		expect(output).not.toContain("Additional services");
	});

	test("all outputs reference docs URLs", () => {
		const output = generatePrompt(base);
		expect(output).toContain("https://husk.akj.io/docs/deployment");
		expect(output).toContain("https://husk.akj.io/docs/configuration");
		expect(output).toContain("https://husk.akj.io/docs/quick-start");
		expect(output).toContain("https://husk.akj.io/docs/connecting");
	});

	test("provider descriptions are human-readable", () => {
		expect(generatePrompt({ ...base, provider: "vps" })).toContain(
			"VPS / bare metal server",
		);
		expect(generatePrompt({ ...base, provider: "docker" })).toContain(
			"Docker already installed",
		);
		expect(generatePrompt({ ...base, provider: "cloud" })).toContain(
			"AWS/GCP/Azure",
		);
		expect(generatePrompt({ ...base, provider: "other" })).toContain(
			"details TBD",
		);
	});

	test("unknown provider falls back to raw value instead of undefined", () => {
		const output = generatePrompt({ ...base, provider: "kubernetes" });
		expect(output).toContain("kubernetes");
		expect(output).not.toContain("undefined");
	});

	test("unknown proxy falls back to raw value instead of undefined", () => {
		const output = generatePrompt({ ...base, proxy: "haproxy" });
		expect(output).toContain("haproxy");
		expect(output).not.toContain("undefined");
	});
});
