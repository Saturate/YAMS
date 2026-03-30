import { describe, expect, test } from "bun:test";
import { inferWorkspaceFromRemote } from "./workspace.js";

describe("inferWorkspaceFromRemote", () => {
	test("extracts org from GitHub HTTPS URL", () => {
		expect(inferWorkspaceFromRemote("https://github.com/Saturate/HUSK")).toBe("Saturate");
	});

	test("extracts org from GitHub HTTPS URL with .git suffix", () => {
		expect(inferWorkspaceFromRemote("https://github.com/my-org/my-repo.git")).toBe("my-org");
	});

	test("extracts org from GitHub SSH URL", () => {
		expect(inferWorkspaceFromRemote("git@github.com:Saturate/HUSK.git")).toBe("Saturate");
	});

	test("extracts org from GitLab HTTPS URL", () => {
		expect(inferWorkspaceFromRemote("https://gitlab.com/my-group/my-project")).toBe("my-group");
	});

	test("extracts org from GitLab SSH URL", () => {
		expect(inferWorkspaceFromRemote("git@gitlab.com:my-group/my-project.git")).toBe("my-group");
	});

	test("extracts org from Azure DevOps HTTPS URL", () => {
		expect(inferWorkspaceFromRemote("https://dev.azure.com/my-org/my-project/_git/my-repo")).toBe(
			"my-org",
		);
	});

	test("extracts org from Bitbucket SSH URL", () => {
		expect(inferWorkspaceFromRemote("git@bitbucket.org:my-team/my-repo.git")).toBe("my-team");
	});

	test("returns null for malformed URLs", () => {
		expect(inferWorkspaceFromRemote("not-a-url")).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(inferWorkspaceFromRemote("")).toBeNull();
	});

	test("returns null for URL with single path segment", () => {
		expect(inferWorkspaceFromRemote("https://github.com/solo")).toBeNull();
	});
});
