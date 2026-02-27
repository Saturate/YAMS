import { honoLogger } from "@logtape/hono";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { admin } from "./admin.js";
import { auth, keys } from "./auth.js";
import { getDb } from "./db.js";
import { ingest } from "./ingest.js";
import { mountMcp } from "./mcp.js";
import { getQdrantClient } from "./qdrant.js";
import { rateLimiter } from "./rate-limit.js";
import { setup, setupGuard } from "./setup.js";

const log = getLogger(["yams", "server"]);

const app = new Hono();

app.use("*", honoLogger({ category: ["yams", "http"] }));
app.use(
	"*",
	secureHeaders({
		contentSecurityPolicy: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'", NONCE],
			styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
			fontSrc: ["'self'", "https://fonts.gstatic.com"],
			imgSrc: ["'self'", "data:"],
			connectSrc: ["'self'"],
			frameAncestors: ["'none'"],
			baseUri: ["'self'"],
			formAction: ["'self'"],
		},
	}),
);
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
app.use("*", setupGuard());

app.get("/health", (c) => {
	const checks: Record<string, string> = { server: "ok" };

	try {
		getDb().query("SELECT 1").get();
		checks.database = "ok";
	} catch {
		checks.database = "error";
	}

	try {
		getQdrantClient();
		checks.qdrant = "ok";
	} catch {
		checks.qdrant = "not configured";
	}

	const overall = checks.database === "ok" ? "ok" : "degraded";
	return c.json({ status: overall, checks });
});

app.use("/setup/*", rateLimiter({ window: 60, max: 5 }));
app.use("/api/auth/*", rateLimiter({ window: 60, max: 10 }));
app.use("/ingest/*", rateLimiter({ window: 60, max: 60 }));
app.use("/mcp/*", rateLimiter({ window: 60, max: 60 }));

app.route("/setup", setup);
app.route("/api/auth", auth);
app.route("/api/keys", keys);
app.route("/api/admin", admin);

app.route("/ingest", ingest);
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
