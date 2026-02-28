import type { Context, Next } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import {
	createApiKey,
	createInvite,
	createUser,
	deleteInvite,
	deleteUser,
	getApiKeyByHash,
	getApiKeyById,
	getInviteByToken,
	getOrCreateJwtSecret,
	getUserById,
	getUserByUsername,
	listApiKeys,
	listInvites,
	listUsers,
	markInviteUsed,
	revokeApiKey,
	updateKeyLastUsed,
} from "./db.js";
import type { AppEnv } from "./env.js";
import type { UserRole } from "./env.js";

export type { ValidatedApiKey } from "./env.js";
export type { AppEnv } from "./env.js";
export type { UserRole } from "./env.js";

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
		c.set("role", (payload.role as UserRole) ?? "user");
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

// --- Session helpers (shared with OAuth) ---

export async function signSessionToken(userId: string, username: string, role: UserRole) {
	return new SignJWT({ sub: userId, username, role })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer("yams")
		.setExpirationTime("24h")
		.sign(getSecretKey());
}

export function setSessionCookie(c: Context, token: string) {
	setCookie(c, COOKIE_NAME, token, {
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 60 * 60 * 24,
		secure: process.env.NODE_ENV === "production",
	});
}

// --- Role-based authorization ---

export function requireRole(...roles: UserRole[]) {
	return async (c: Context<AppEnv>, next: Next) => {
		const role = c.get("role");
		if (!roles.includes(role)) {
			return c.json({ error: "Forbidden." }, 403);
		}
		return next();
	};
}

// --- Auth routes (login) ---

const auth = new Hono<AppEnv>();

// Dummy hash to compare against when user doesn't exist (constant-time defense)
const DUMMY_HASH = await Bun.password.hash("dummy-timing-defense");

auth.post("/login", async (c) => {
	const body = await c.req.json<{ username?: string; password?: string }>();

	const username = body.username?.trim();
	const password = body.password;

	if (!username || !password) {
		return c.json({ error: "Invalid credentials." }, 401);
	}

	const user = getUserByUsername(username);
	// Always run verify to prevent timing-based username enumeration
	const hashToCheck = user?.password_hash ?? DUMMY_HASH;
	const valid = await Bun.password.verify(password, hashToCheck);

	if (!user || !user.password_hash || !valid) {
		return c.json({ error: "Invalid credentials." }, 401);
	}

	const token = await signSessionToken(user.id, user.username, user.role as UserRole);

	setSessionCookie(c, token);

	return c.json({ username: user.username, role: user.role });
});

auth.post("/logout", (c) => {
	deleteCookie(c, COOKIE_NAME, { path: "/" });
	return c.json({ ok: true });
});

auth.get("/me", jwtMiddleware, (c) => {
	return c.json({
		username: c.get("username"),
		role: c.get("role"),
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

keys.get("/:id/hooks-config", (c) => {
	const id = c.req.param("id");
	const existing = getApiKeyById(id);

	if (!existing || existing.user_id !== c.get("userId")) {
		return c.json({ error: "Key not found." }, 404);
	}

	const origin = new URL(c.req.url).origin;
	const config = {
		hooks: {
			SessionStart: [
				{
					hooks: [
						{
							type: "http",
							url: `${origin}/hooks/session-start`,
							headers: { Authorization: "Bearer $YAMS_API_KEY" },
							timeout: 5,
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					hooks: [
						{
							type: "http",
							url: `${origin}/hooks/observation`,
							headers: { Authorization: "Bearer $YAMS_API_KEY" },
							timeout: 2,
						},
					],
				},
			],
			PostToolUse: [
				{
					hooks: [
						{
							type: "http",
							url: `${origin}/hooks/observation`,
							headers: { Authorization: "Bearer $YAMS_API_KEY" },
							timeout: 2,
						},
					],
				},
			],
			Stop: [
				{
					hooks: [
						{
							type: "http",
							url: `${origin}/hooks/observation`,
							headers: { Authorization: "Bearer $YAMS_API_KEY" },
							timeout: 2,
						},
					],
				},
			],
			SessionEnd: [
				{
					hooks: [
						{
							type: "http",
							url: `${origin}/hooks/session-end`,
							headers: { Authorization: "Bearer $YAMS_API_KEY" },
							timeout: 5,
						},
					],
				},
			],
		},
	};

	return c.json(config);
});

// --- User management routes (admin-only) ---

const users = new Hono<AppEnv>();

users.use("*", jwtMiddleware);
users.use("*", requireRole("admin"));

users.get("/", (c) => {
	const allUsers = listUsers();
	return c.json(
		allUsers.map((u) => {
			const keys = listApiKeys(u.id);
			return {
				id: u.id,
				username: u.username,
				role: u.role,
				oauth_provider: u.oauth_provider,
				avatar_url: u.avatar_url,
				created_at: u.created_at,
				key_count: keys.filter((k) => k.is_active).length,
			};
		}),
	);
});

users.post("/", async (c) => {
	const body = await c.req.json<{ username?: string; password?: string; role?: string }>();

	const username = body.username?.trim();
	const password = body.password;
	const role = body.role ?? "user";

	if (!username || username.length < 3) {
		return c.json({ error: "Username must be at least 3 characters." }, 400);
	}
	if (!password || password.length < 8) {
		return c.json({ error: "Password must be at least 8 characters." }, 400);
	}
	if (role !== "admin" && role !== "user") {
		return c.json({ error: "Role must be 'admin' or 'user'." }, 400);
	}

	const existing = getUserByUsername(username);
	if (existing) {
		return c.json({ error: "Username already taken." }, 409);
	}

	const hash = await Bun.password.hash(password);
	const id = createUser(username, hash, { role });

	return c.json({ id, username, role }, 201);
});

users.delete("/:id", (c) => {
	const id = c.req.param("id");

	if (id === c.get("userId")) {
		return c.json({ error: "Cannot delete your own account." }, 400);
	}

	const user = getUserById(id);
	if (!user) {
		return c.json({ error: "User not found." }, 404);
	}

	deleteUser(id);
	return c.json({ id, deleted: true });
});

// --- Invite routes ---

const invites = new Hono<AppEnv>();

// Admin routes (create, list, delete)
invites.post("/", jwtMiddleware, requireRole("admin"), async (c) => {
	const body = await c.req.json<{ email?: string; role?: string; expires_in_days?: number }>();

	const email = body.email?.trim().toLowerCase();
	if (!email || !email.includes("@")) {
		return c.json({ error: "Valid email is required." }, 400);
	}

	const role = body.role ?? "user";
	if (role !== "admin" && role !== "user") {
		return c.json({ error: "Role must be 'admin' or 'user'." }, 400);
	}

	const days = body.expires_in_days ?? 7;
	const expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString();

	const { id, token } = createInvite({
		email,
		role,
		createdBy: c.get("userId"),
		expiresAt,
	});

	const origin = new URL(c.req.url).origin;
	const inviteUrl = `${origin}/invite/${token}`;

	return c.json({ id, email, role, token, invite_url: inviteUrl, expires_at: expiresAt }, 201);
});

invites.get("/", jwtMiddleware, requireRole("admin"), (c) => {
	const all = listInvites();
	return c.json(
		all.map((inv) => ({
			id: inv.id,
			email: inv.email,
			role: inv.role,
			created_at: inv.created_at,
			expires_at: inv.expires_at,
			used_at: inv.used_at,
		})),
	);
});

invites.delete("/:id", jwtMiddleware, requireRole("admin"), (c) => {
	const id = c.req.param("id");
	if (!deleteInvite(id)) {
		return c.json({ error: "Invite not found." }, 404);
	}
	return c.json({ id, deleted: true });
});

// Public routes (validate + accept)
invites.get("/:token/validate", (c) => {
	const token = c.req.param("token");
	const invite = getInviteByToken(token);

	if (!invite) {
		return c.json({ error: "Invalid invite link." }, 404);
	}
	if (invite.used_at) {
		return c.json({ error: "This invite has already been used." }, 410);
	}
	if (new Date(invite.expires_at) < new Date()) {
		return c.json({ error: "This invite has expired." }, 410);
	}

	return c.json({ email: invite.email, role: invite.role });
});

invites.post("/:token/accept", async (c) => {
	const token = c.req.param("token");
	const invite = getInviteByToken(token);

	if (!invite) {
		return c.json({ error: "Invalid invite link." }, 404);
	}
	if (invite.used_at) {
		return c.json({ error: "This invite has already been used." }, 410);
	}
	if (new Date(invite.expires_at) < new Date()) {
		return c.json({ error: "This invite has expired." }, 410);
	}

	const body = await c.req.json<{ username?: string; password?: string }>();

	const username = body.username?.trim();
	const password = body.password;

	if (!username || username.length < 3) {
		return c.json({ error: "Username must be at least 3 characters." }, 400);
	}
	if (!password || password.length < 8) {
		return c.json({ error: "Password must be at least 8 characters." }, 400);
	}

	const existing = getUserByUsername(username);
	if (existing) {
		return c.json({ error: "Username already taken." }, 409);
	}

	const hash = await Bun.password.hash(password);
	const role = invite.role as UserRole;
	const id = createUser(username, hash, { role });
	markInviteUsed(invite.id);

	const sessionToken = await signSessionToken(id, username, role);
	setSessionCookie(c, sessionToken);

	return c.json({ id, username, role }, 201);
});

export { auth, keys, users, invites };
