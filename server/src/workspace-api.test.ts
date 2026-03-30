import { beforeEach, describe, expect, test } from "bun:test";
import type { EmbeddingProvider } from "./embeddings.js";
import { setProvider } from "./embeddings.js";
import type { StorageProvider } from "./storage.js";
import { setStorageProvider } from "./storage.js";
import { createRegularUser, createTestApp, getToken, setupAdmin } from "./test-helpers.js";

const mockProvider: EmbeddingProvider = {
	name: "mock",
	dimensions: 768,
	embed: () => Promise.resolve(new Array(768).fill(0.1)),
};

const mockStorage: StorageProvider = {
	name: "mock",
	init: () => Promise.resolve(),
	upsert: () => Promise.resolve(),
	search: () => Promise.resolve([]),
	delete: () => Promise.resolve(),
	healthy: () => Promise.resolve(true),
};

let app: ReturnType<typeof createTestApp>;
let adminToken: string;

async function authed(path: string, token: string, init?: RequestInit) {
	return app.request(path, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
}

describe("workspace API", () => {
	beforeEach(async () => {
		app = createTestApp();
		setProvider(mockProvider);
		setStorageProvider(mockStorage);
		await setupAdmin(app);
		adminToken = await getToken(app);
	});

	test("create and list workspaces", async () => {
		const create = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "my-workspace" }),
		});
		expect(create.status).toBe(201);
		const { id } = (await create.json()) as { id: string };

		const list = await authed("/api/admin/workspaces", adminToken);
		const body = (await list.json()) as { workspaces: { id: string; name: string }[] };
		expect(body.workspaces).toHaveLength(1);
		expect(body.workspaces[0]?.name).toBe("my-workspace");
		expect(body.workspaces[0]?.id).toBe(id);
	});

	test("rejects invalid workspace names", async () => {
		const res = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "no spaces allowed" }),
		});
		expect(res.status).toBe(400);
	});

	test("allows unicode workspace names", async () => {
		for (const name of ["ÆØÅ-projekt", "café", "über-team", "日本語"]) {
			const res = await authed("/api/admin/workspaces", adminToken, {
				method: "POST",
				body: JSON.stringify({ name }),
			});
			expect(res.status).toBe(201);
		}
	});

	test("allows hyphens, underscores, dots in names", async () => {
		for (const name of ["my-workspace", "my_workspace", "my.workspace", "a1-b2_c3.d4"]) {
			const res = await authed("/api/admin/workspaces", adminToken, {
				method: "POST",
				body: JSON.stringify({ name }),
			});
			expect(res.status).toBe(201);
		}
	});

	test("rejects names starting with special characters", async () => {
		for (const name of ["-starts-with-dash", ".starts-with-dot", "_starts-with-underscore"]) {
			const res = await authed("/api/admin/workspaces", adminToken, {
				method: "POST",
				body: JSON.stringify({ name }),
			});
			expect(res.status).toBe(400);
		}
	});

	test("rejects empty and whitespace-only names", async () => {
		for (const name of ["", "   "]) {
			const res = await authed("/api/admin/workspaces", adminToken, {
				method: "POST",
				body: JSON.stringify({ name }),
			});
			expect(res.status).toBe(400);
		}
	});

	test("rejects duplicate workspace names for same user", async () => {
		await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "dupe" }),
		});
		const res = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "dupe" }),
		});
		expect(res.status).toBe(409);
	});

	test("different users can have same workspace name", async () => {
		await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "shared-name" }),
		});

		const user = await createRegularUser(app, adminToken);
		const res = await authed("/api/admin/workspaces", user.token, {
			method: "POST",
			body: JSON.stringify({ name: "shared-name" }),
		});
		expect(res.status).toBe(201);
	});

	test("users can only see their own workspaces", async () => {
		await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "admin-ws" }),
		});

		const user = await createRegularUser(app, adminToken);
		await authed("/api/admin/workspaces", user.token, {
			method: "POST",
			body: JSON.stringify({ name: "user-ws" }),
		});

		const adminList = await authed("/api/admin/workspaces", adminToken);
		const adminBody = (await adminList.json()) as {
			workspaces: { name: string }[];
		};
		// Admin sees all
		expect(adminBody.workspaces).toHaveLength(2);

		const userList = await authed("/api/admin/workspaces", user.token);
		const userBody = (await userList.json()) as {
			workspaces: { name: string }[];
		};
		// User sees only their own
		expect(userBody.workspaces).toHaveLength(1);
		expect(userBody.workspaces[0]?.name).toBe("user-ws");
	});

	test("user cannot delete another user's workspace", async () => {
		const create = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "admin-ws" }),
		});
		const { id } = (await create.json()) as { id: string };

		const user = await createRegularUser(app, adminToken);
		const del = await authed(`/api/admin/workspaces/${id}`, user.token, {
			method: "DELETE",
		});
		expect(del.status).toBe(404);
	});

	test("user cannot update another user's workspace", async () => {
		const create = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "admin-ws" }),
		});
		const { id } = (await create.json()) as { id: string };

		const user = await createRegularUser(app, adminToken);
		const put = await authed(`/api/admin/workspaces/${id}`, user.token, {
			method: "PUT",
			body: JSON.stringify({ name: "stolen" }),
		});
		expect(put.status).toBe(404);
	});

	test("assign and remove projects", async () => {
		const create = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "my-ws" }),
		});
		const { id } = (await create.json()) as { id: string };

		const assign = await authed(`/api/admin/workspaces/${id}/projects`, adminToken, {
			method: "POST",
			body: JSON.stringify({ git_remote: "github.com/org/repo" }),
		});
		expect(assign.status).toBe(201);

		const detail = await authed(`/api/admin/workspaces/${id}`, adminToken);
		const body = (await detail.json()) as { projects: string[] };
		expect(body.projects).toContain("github.com/org/repo");

		const remove = await authed(
			`/api/admin/workspaces/${id}/projects/${encodeURIComponent("github.com/org/repo")}`,
			adminToken,
			{ method: "DELETE" },
		);
		expect(remove.status).toBe(200);
	});

	test("cannot steal project from another user's workspace", async () => {
		const adminCreate = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "admin-ws" }),
		});
		const { id: adminWsId } = (await adminCreate.json()) as { id: string };
		await authed(`/api/admin/workspaces/${adminWsId}/projects`, adminToken, {
			method: "POST",
			body: JSON.stringify({ git_remote: "github.com/org/repo" }),
		});

		const user = await createRegularUser(app, adminToken);
		const userCreate = await authed("/api/admin/workspaces", user.token, {
			method: "POST",
			body: JSON.stringify({ name: "user-ws" }),
		});
		const { id: userWsId } = (await userCreate.json()) as { id: string };

		const steal = await authed(`/api/admin/workspaces/${userWsId}/projects`, user.token, {
			method: "POST",
			body: JSON.stringify({ git_remote: "github.com/org/repo" }),
		});
		expect(steal.status).toBe(409);
	});

	test("cannot remove project from another user's workspace", async () => {
		const adminCreate = await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "admin-ws" }),
		});
		const { id: adminWsId } = (await adminCreate.json()) as { id: string };
		await authed(`/api/admin/workspaces/${adminWsId}/projects`, adminToken, {
			method: "POST",
			body: JSON.stringify({ git_remote: "github.com/org/repo" }),
		});

		const user = await createRegularUser(app, adminToken);
		const userCreate = await authed("/api/admin/workspaces", user.token, {
			method: "POST",
			body: JSON.stringify({ name: "user-ws" }),
		});
		const { id: userWsId } = (await userCreate.json()) as { id: string };

		// Try to remove admin's project through user's workspace
		const remove = await authed(
			`/api/admin/workspaces/${userWsId}/projects/${encodeURIComponent("github.com/org/repo")}`,
			user.token,
			{ method: "DELETE" },
		);
		expect(remove.status).toBe(404);
	});

	test("workspace count in stats", async () => {
		await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "ws-1" }),
		});
		await authed("/api/admin/workspaces", adminToken, {
			method: "POST",
			body: JSON.stringify({ name: "ws-2" }),
		});

		const stats = await authed("/api/admin/stats", adminToken);
		const body = (await stats.json()) as { workspaces: number };
		expect(body.workspaces).toBe(2);
	});
});
