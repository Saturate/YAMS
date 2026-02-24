import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { admin } from "./admin.js";
import { auth, keys } from "./auth.js";
import { ingest } from "./ingest.js";
import { mountMcp } from "./mcp.js";
import { setup, setupGuard } from "./setup.js";

const app = new Hono();

app.use("*", logger());
app.use("*", setupGuard());

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/setup", setup);
app.route("/api/auth", auth);
app.route("/api/keys", keys);
app.route("/api/admin", admin);

app.route("/ingest", ingest);
mountMcp(app);

// Serve built UI static assets
app.use("/assets/*", serveStatic({ root: "./ui/dist" }));

// SPA fallback — serve index.html for all non-API routes
app.get("*", serveStatic({ root: "./ui/dist", path: "index.html" }));

app.onError((err, c) => {
	console.error(err);
	return c.json({ error: err.message || "Internal server error." }, 500);
});

export { app };
