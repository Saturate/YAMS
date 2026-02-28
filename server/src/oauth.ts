import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { setSessionCookie, signSessionToken } from "./auth.js";
import { createUser, getUserByOAuth } from "./db.js";
import type { UserRole } from "./env.js";

const log = getLogger(["yams", "oauth"]);

interface GitHubTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
}

interface GitHubUser {
	id: number;
	login: string;
	avatar_url: string;
}

interface GitHubOrg {
	login: string;
}

export function isGitHubOAuthEnabled(): boolean {
	return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

const oauth = new Hono();

oauth.get("/github", (c) => {
	const clientId = process.env.GITHUB_CLIENT_ID;
	if (!clientId) {
		return c.json({ error: "GitHub OAuth not configured." }, 404);
	}

	const origin = new URL(c.req.url).origin;
	const redirectUri = `${origin}/api/auth/github/callback`;

	// CSRF protection: random state stored in a short-lived cookie
	const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
	setCookie(c, "oauth_state", state, {
		httpOnly: true,
		sameSite: "Lax",
		path: "/api/auth/github/callback",
		maxAge: 600,
		secure: process.env.NODE_ENV === "production",
	});

	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: "read:user read:org",
		state,
	});

	return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

oauth.get("/github/callback", async (c) => {
	const clientId = process.env.GITHUB_CLIENT_ID;
	const clientSecret = process.env.GITHUB_CLIENT_SECRET;

	if (!clientId || !clientSecret) {
		return c.json({ error: "GitHub OAuth not configured." }, 404);
	}

	const code = c.req.query("code");
	const returnedState = c.req.query("state");
	const storedState = getCookie(c, "oauth_state");

	if (!code || !returnedState || !storedState || returnedState !== storedState) {
		return c.redirect("/login?error=oauth_failed");
	}

	// Clear state cookie immediately to prevent replay
	deleteCookie(c, "oauth_state", { path: "/api/auth/github/callback" });

	const origin = new URL(c.req.url).origin;
	const redirectUri = `${origin}/api/auth/github/callback`;

	try {
		// Exchange code for access token
		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
			}),
		});

		const tokenData = (await tokenRes.json()) as GitHubTokenResponse;
		if (!tokenData.access_token) {
			log.warn("GitHub OAuth token exchange failed");
			return c.redirect("/login?error=oauth_failed");
		}

		// Fetch GitHub user info
		const userRes = await fetch("https://api.github.com/user", {
			headers: { Authorization: `Bearer ${tokenData.access_token}` },
		});
		const ghUser = (await userRes.json()) as GitHubUser;

		// Org restriction: required unless OAUTH_ALLOWED_ORGS="*"
		const allowedOrgs = process.env.OAUTH_ALLOWED_ORGS;

		// Existing users bypass org check (they were already approved)
		const existingUser = getUserByOAuth("github", String(ghUser.id));
		if (!existingUser) {
			if (!allowedOrgs) {
				log.info("GitHub user {user} rejected: OAUTH_ALLOWED_ORGS not configured", {
					user: ghUser.login,
				});
				return c.redirect("/login?error=org_restricted");
			}

			if (allowedOrgs !== "*") {
				const orgs = allowedOrgs.split(",").map((o) => o.trim().toLowerCase());
				const orgRes = await fetch("https://api.github.com/user/orgs", {
					headers: { Authorization: `Bearer ${tokenData.access_token}` },
				});
				const userOrgs = (await orgRes.json()) as GitHubOrg[];
				const userOrgNames = userOrgs.map((o) => o.login.toLowerCase());
				const hasOrg = orgs.some((o) => userOrgNames.includes(o));

				if (!hasOrg) {
					log.info("GitHub user {user} not in allowed orgs", { user: ghUser.login });
					return c.redirect("/login?error=org_restricted");
				}
			}
		}

		// Find or create local user
		const oauthId = String(ghUser.id);
		let user = existingUser;
		let role: UserRole = "user";

		if (!user) {
			const id = createUser(ghUser.login, null, {
				role: "user",
				oauthProvider: "github",
				oauthId,
				avatarUrl: ghUser.avatar_url,
			});
			user = {
				id,
				username: ghUser.login,
				password_hash: null,
				role: "user",
				oauth_provider: "github",
				oauth_id: oauthId,
				avatar_url: ghUser.avatar_url,
				created_at: new Date().toISOString(),
			};
			log.info("Created OAuth user {username}", { username: ghUser.login });
		} else {
			role = user.role as UserRole;
		}

		const token = await signSessionToken(user.id, user.username, role);
		setSessionCookie(c, token);

		return c.redirect("/dashboard");
	} catch (err) {
		log.error("GitHub OAuth error: {error}", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.redirect("/login?error=oauth_failed");
	}
});

export { oauth };
