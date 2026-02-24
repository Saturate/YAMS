import type { Context, Next } from "hono";
import { Hono } from "hono";
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

function getSecretKey(): Uint8Array {
	const secret = getOrCreateJwtSecret();
	return new TextEncoder().encode(secret);
}

// --- JWT middleware ---

export async function jwtMiddleware(c: Context, next: Next) {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return c.json({ error: "Authorization required." }, 401);
	}

	const token = header.slice(7);

	// Don't treat API keys as JWTs
	if (token.startsWith("yams_")) {
		return c.json({ error: "Authorization required." }, 401);
	}

	try {
		const { payload } = await jwtVerify(token, getSecretKey(), { issuer: "yams" });
		c.set("userId", payload.sub);
		c.set("username", payload.username);
	} catch {
		return c.json({ error: "Invalid or expired token." }, 401);
	}

	return next();
}

// --- Bearer key validation ---

export interface ValidatedApiKey {
	id: string;
	user_id: string;
	label: string;
	key_prefix: string;
	is_active: number;
	expires_at: string | null;
	created_at: string;
	last_used_at: string | null;
}

export async function validateBearerKey(
	authHeader: string | undefined,
): Promise<{ key: ValidatedApiKey } | { error: string }> {
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

export async function bearerKeyMiddleware(c: Context, next: Next) {
	const result = await validateBearerKey(c.req.header("Authorization"));
	if ("error" in result) {
		return c.json({ error: result.error }, 401);
	}

	c.set("apiKey", result.key);
	return next();
}

// --- Auth routes (login) ---

const auth = new Hono();

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

	return c.json({ token });
});

// --- Key management routes (JWT-protected) ---

const keys = new Hono();

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

	const userId = c.get("userId") as string;
	const id = createApiKey({ userId, label, keyHash, keyPrefix, expiresAt });

	return c.json({ id, key: rawKey, label, key_prefix: keyPrefix, expires_at: expiresAt }, 201);
});

keys.get("/me", (c) => {
	const key = c.get("apiKey") as {
		id: string;
		label: string;
		key_prefix: string;
		is_active: number;
		expires_at: string | null;
		created_at: string;
		last_used_at: string | null;
	};
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
	const allKeys = listApiKeys();
	return c.json(
		allKeys.map((k) => ({
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

	if (!existing) {
		return c.json({ error: "Key not found." }, 404);
	}

	revokeApiKey(id);
	return c.json({ id, revoked: true });
});

export { auth, keys };
