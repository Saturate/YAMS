import type { Context, Next } from "hono";
import { Hono } from "hono";
import { createUser, getUserCount } from "./db.js";

const GUARDED_PREFIXES = ["/api/", "/ingest", "/mcp"];

export function setupGuard() {
	return async (c: Context, next: Next) => {
		const path = new URL(c.req.url).pathname;

		if (path === "/health") return next();

		const count = getUserCount();
		const isGuardedRoute =
			GUARDED_PREFIXES.some((p) => path.startsWith(p)) ||
			(path === "/setup" && c.req.method === "POST");

		if (count === 0 && isGuardedRoute && !path.startsWith("/setup")) {
			return c.json({ error: "Server not configured. Visit /setup to create an admin." }, 503);
		}

		if (count > 0 && path.startsWith("/setup") && c.req.method === "POST") {
			return c.json({ error: "Setup already completed." }, 403);
		}

		return next();
	};
}

const setup = new Hono();

setup.post("/", async (c) => {
	const body = await c.req.json<{ username?: string; password?: string }>();

	const username = body.username?.trim();
	const password = body.password;

	if (!username || username.length < 3) {
		return c.json({ error: "Username must be at least 3 characters." }, 400);
	}
	if (!password || password.length < 8) {
		return c.json({ error: "Password must be at least 8 characters." }, 400);
	}

	const hash = await Bun.password.hash(password);

	// Re-check atomically after async hash to prevent TOCTOU race
	if (getUserCount() > 0) {
		return c.json({ error: "Setup already completed." }, 403);
	}

	const id = createUser(username, hash);

	return c.json({ id, username }, 201);
});

export { setup };
