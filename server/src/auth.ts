import type { Context, Next } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import {
	createApiKey,
	getApiKeyByHash,
	getApiKeyById,
	getOrCreateJwtSecret,
	getUserByUsername,
	listApiKeys,
	revokeApiKey,
	updateKeyLastUsed,
} from "./db.js";
import type { AppEnv } from "./env.js";

export type { ValidatedApiKey } from "./env.js";
export type { AppEnv } from "./env.js";

const COOKIE_NAME = "yams_session";

function getSecretKey(): Uint8Array {
	const secret = getOrCreateJwtSecret();
	return new TextEncoder().encode(secret);
}

// --- JWT middleware ---

export async function jwtMiddleware(c: Context<AppEnv>, next: Next) {
	// Check cookie first, then Authorization header
	const cookieToken = getCookie(c, COOKIE_NAME);
	const header = c.req.header("Authorization");
	const token = cookieToken ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);

	if (!token || token.startsWith("yams_")) {
		return c.json({ error: "Authorization required." }, 401);
	}

	try {
		const { payload } = await jwtVerify(token, getSecretKey(), { issuer: "yams" });
		c.set("userId", payload.sub as string);
		c.set("username", payload.username as string);
	} catch {
		return c.json({ error: "Invalid or expired token." }, 401);
	}

	return next();
}

// --- Bearer key validation ---

export async function validateBearerKey(
	authHeader: string | undefined,
): Promise<{ key: import("./env.js").ValidatedApiKey } | { error: string }> {
	if (!authHeader?.startsWith("Bearer ")) {
		return { error: "Authorization required." };
	}

	const token = authHeader.slice(7);
	if (!token.startsWith("yams_")) {
		return { error: "Invalid API key." };
	}

	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const hash = Buffer.from(hashBuffer).toString("hex");

	const key = getApiKeyByHash(hash);
	if (!key) {
		return { error: "Invalid API key." };
	}

	if (!key.is_active) {
		return { error: "API key has been revoked." };
	}

	if (key.expires_at && new Date(key.expires_at) < new Date()) {
		return { error: "API key has expired." };
	}

	updateKeyLastUsed(key.id);
	return { key };
}

// --- Bearer key middleware ---

export async function bearerKeyMiddleware(c: Context<AppEnv>, next: Next) {
	const result = await validateBearerKey(c.req.header("Authorization"));
	if ("error" in result) {
		return c.json({ error: result.error }, 401);
	}

	c.set("apiKey", result.key);
	return next();
}

// --- Auth routes (login) ---

const auth = new Hono<AppEnv>();

auth.post("/login", async (c) => {
	const body = await c.req.json<{ username?: string; password?: string }>();

	const username = body.username?.trim();
	const password = body.password;

	if (!username || !password) {
		return c.json({ error: "Invalid credentials." }, 401);
	}

	const user = getUserByUsername(username);
	if (!user) {
		return c.json({ error: "Invalid credentials." }, 401);
	}

	const valid = await Bun.password.verify(password, user.password_hash);
	if (!valid) {
		return c.json({ error: "Invalid credentials." }, 401);
	}

	const token = await new SignJWT({ sub: user.id, username: user.username })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer("yams")
		.setExpirationTime("24h")
		.sign(getSecretKey());

	setCookie(c, COOKIE_NAME, token, {
		httpOnly: true,
		sameSite: "Strict",
		path: "/",
		maxAge: 60 * 60 * 24,
		secure: process.env.NODE_ENV === "production",
	});

	return c.json({ username: user.username });
});

auth.post("/logout", (c) => {
	deleteCookie(c, COOKIE_NAME, { path: "/" });
	return c.json({ ok: true });
});

auth.get("/me", jwtMiddleware, (c) => {
	return c.json({
		username: c.get("username"),
	});
});

// --- Key management routes (JWT-protected) ---

const keys = new Hono<AppEnv>();

keys.use("/*", async (c, next) => {
	const path = new URL(c.req.url).pathname;

	// /api/keys/me uses bearer key auth
	if (path === "/api/keys/me") {
		return bearerKeyMiddleware(c, next);
	}

	return jwtMiddleware(c, next);
});

keys.post("/", async (c) => {
	const body = await c.req.json<{ label?: string; expires_in?: number }>();

	const label = body.label?.trim();
	if (!label) {
		return c.json({ error: "Label is required." }, 400);
	}

	const rawKey = `yams_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
	const keyHash = Buffer.from(hashBuffer).toString("hex");
	const keyPrefix = rawKey.slice(0, 12);

	let expiresAt: string | null = null;
	if (body.expires_in != null) {
		expiresAt = new Date(Date.now() + body.expires_in * 1000).toISOString();
	}

	const userId = c.get("userId");
	const id = createApiKey({ userId, label, keyHash, keyPrefix, expiresAt });

	return c.json({ id, key: rawKey, label, key_prefix: keyPrefix, expires_at: expiresAt }, 201);
});

keys.get("/me", (c) => {
	const key = c.get("apiKey");
	return c.json({
		id: key.id,
		label: key.label,
		key_prefix: key.key_prefix,
		is_active: Boolean(key.is_active),
		expires_at: key.expires_at,
		created_at: key.created_at,
		last_used_at: key.last_used_at,
	});
});

keys.get("/", (c) => {
	const userId = c.get("userId");
	const userKeys = listApiKeys(userId);
	return c.json(
		userKeys.map((k) => ({
			id: k.id,
			label: k.label,
			key_prefix: k.key_prefix,
			is_active: Boolean(k.is_active),
			expires_at: k.expires_at,
			created_at: k.created_at,
			last_used_at: k.last_used_at,
		})),
	);
});

keys.delete("/:id", (c) => {
	const id = c.req.param("id");
	const existing = getApiKeyById(id);

	if (!existing || existing.user_id !== c.get("userId")) {
		return c.json({ error: "Key not found." }, 404);
	}

	revokeApiKey(id);
	return c.json({ id, revoked: true });
});

export { auth, keys };
