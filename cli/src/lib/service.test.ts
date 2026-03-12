import { describe, expect, test } from "bun:test";
import { launchdPlist, systemdUnit } from "./service.js";
import { paths } from "./paths.js";

describe("launchdPlist", () => {
	const bunPath = "/opt/bun/bin/bun";
	const configPath = "/home/user/.husk/husk.toml";
	const plist = launchdPlist(bunPath, configPath);

	test("contains correct Label", () => {
		expect(plist).toContain("<string>io.husk.server</string>");
	});

	test("contains bun path in ProgramArguments", () => {
		expect(plist).toContain(`<string>${bunPath}</string>`);
	});

	test("contains config path under HUSK_CONFIG key", () => {
		// Verify key and value are adjacent
		expect(plist).toContain(
			`<key>HUSK_CONFIG</key>\n\t\t<string>${configPath}</string>`,
		);
	});

	test("WorkingDirectory points to server subdir", () => {
		const expected = `${paths.server}/server`;
		expect(plist).toContain(
			`<key>WorkingDirectory</key>\n\t<string>${expected}</string>`,
		);
	});

	test("log paths reference husk.log", () => {
		expect(plist).toContain(
			`<key>StandardOutPath</key>\n\t<string>${paths.log}</string>`,
		);
		expect(plist).toContain(
			`<key>StandardErrorPath</key>\n\t<string>${paths.log}</string>`,
		);
	});

	test("has valid plist structure", () => {
		expect(plist).toMatch(/^<\?xml version="1\.0"/);
		expect(plist).toContain("<!DOCTYPE plist");
		expect(plist).toMatch(/<plist version="1\.0">/);
		expect(plist).toMatch(/<\/plist>$/);
	});

	test("escapes XML special characters in bun path", () => {
		const dangerous = launchdPlist(
			'/path/with/<script>&"chars',
			"/safe/path",
		);
		expect(dangerous).not.toContain("<script>");
		expect(dangerous).toContain("&lt;script&gt;");
		expect(dangerous).toContain("&amp;");
		expect(dangerous).toContain("&quot;");
	});

	test("escapes XML special characters in config path", () => {
		const dangerous = launchdPlist("/safe/bun", "/path/<evil>&stuff");
		expect(dangerous).not.toContain("<evil>");
		expect(dangerous).toContain("&lt;evil&gt;");
		expect(dangerous).toContain("&amp;stuff");
	});
});

describe("systemdUnit", () => {
	const bunPath = "/opt/bun/bin/bun";
	const configPath = "/home/user/.husk/husk.toml";
	const unit = systemdUnit(bunPath, configPath);

	test("ExecStart has full bun command", () => {
		expect(unit).toContain(`ExecStart=${bunPath} run src/index.ts`);
	});

	test("WorkingDirectory points to server subdir", () => {
		expect(unit).toContain(
			`WorkingDirectory=${paths.server}/server`,
		);
	});

	test("Environment sets HUSK_CONFIG", () => {
		expect(unit).toContain(`Environment=HUSK_CONFIG=${configPath}`);
	});

	test("Restart is on-failure", () => {
		expect(unit).toContain("Restart=on-failure");
	});

	test("has all three systemd sections", () => {
		expect(unit).toContain("[Unit]");
		expect(unit).toContain("[Service]");
		expect(unit).toContain("[Install]");
		expect(unit).toContain("WantedBy=default.target");
	});

	test("log output uses append mode", () => {
		expect(unit).toContain(`StandardOutput=append:${paths.log}`);
		expect(unit).toContain(`StandardError=append:${paths.log}`);
	});

	test("description is set", () => {
		expect(unit).toContain("Description=HUSK Memory Server");
	});
});
