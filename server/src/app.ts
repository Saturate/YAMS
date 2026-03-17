import { honoLogger } from "@logtape/hono";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { admin } from "./admin.js";
import { auth, invites, keys, users } from "./auth.js";
import { getDb } from "./db.js";
import { graphApi } from "./graph-api.js";
import { getGraphProviderOrNull } from "./graph.js";
import { ingest } from "./ingest.js";
import { mountMcp } from "./mcp.js";
import { isGitHubOAuthEnabled, oauth } from "./oauth.js";
import { rateLimiter } from "./rate-limit.js";
import { sessions } from "./sessions.js";
import { setup, setupGuard } from "./setup.js";
import { getStorageProvider } from "./storage.js";

const log = getLogger(["husk", "server"]);

const app = new Hono();

app.use("*", honoLogger({ category: ["husk", "http"] }));
app.use(
	"*",
	secureHeaders({
		contentSecurityPolicy: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'", NONCE],
			styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
			fontSrc: ["'self'", "https://fonts.gstatic.com"],
			imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
			connectSrc: ["'self'"],
			frameAncestors: ["'none'"],
			baseUri: ["'self'"],
			formAction: ["'self'"],
		},
	}),
);
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
app.use("*", setupGuard());

app.get("/health", async (c) => {
	const checks: Record<string, string> = { server: "ok" };

	try {
		getDb().query("SELECT 1").get();
		checks.database = "ok";
	} catch {
		checks.database = "error";
	}

	try {
		const storage = getStorageProvider();
		checks.vector_storage = (await storage.healthy()) ? "ok" : "error";
	} catch {
		checks.vector_storage = "not configured";
	}

	const graphProvider = getGraphProviderOrNull();
	if (graphProvider) {
		try {
			checks.graph = (await graphProvider.healthy()) ? "ok" : "error";
		} catch {
			checks.graph = "error";
		}
	}

	const overall = checks.database === "ok" ? "ok" : "degraded";
	return c.json({ status: overall, checks });
});

app.use("/setup/*", rateLimiter({ window: 60, max: 5 }));
app.use("/api/auth/*", rateLimiter({ window: 60, max: 10 }));
app.use("/api/users/*", rateLimiter({ window: 60, max: 20 }));
app.use("/api/invites/*", rateLimiter({ window: 60, max: 10 }));
app.use("/ingest/*", rateLimiter({ window: 60, max: 60 }));
app.use("/mcp/*", rateLimiter({ window: 60, max: 60 }));
app.use("/hooks/*", rateLimiter({ window: 60, max: 120 }));

app.route("/setup", setup);
app.route("/api/auth", auth);
app.route("/api/auth", oauth);
app.route("/api/keys", keys);
app.route("/api/users", users);
app.route("/api/invites", invites);
app.route("/api/admin", admin);

// Providers endpoint - returns which auth methods are available
app.get("/api/auth/providers", (c) => {
	return c.json({
		github: isGitHubOAuthEnabled(),
	});
});

app.route("/api/graph", graphApi);

app.route("/ingest", ingest);
app.route("/hooks", sessions);
mountMcp(app);

// Serve built UI static assets
app.use("/assets/*", serveStatic({ root: "./ui/dist" }));
app.use("/favicon.svg", serveStatic({ root: "./ui/dist", path: "favicon.svg" }));

// SPA fallback - serve index.html with nonce injected into script tags
app.get("*", async (c) => {
	try {
		const html = await Bun.file("./ui/dist/index.html").text();
		const nonce = c.get("secureHeadersNonce");
		const nonced = html.replace(/<script /g, `<script nonce="${nonce}" `);
		return c.html(nonced);
	} catch {
		return c.notFound();
	}
});

app.onError((err, c) => {
	if (err instanceof SyntaxError && err.message.includes("JSON")) {
		return c.json({ error: "Invalid JSON in request body." }, 400);
	}
	log.error(err);
	return c.json({ error: "Internal server error." }, 500);
});

export { app };
