import type { Context, Next } from "hono";

interface RateLimitOpts {
	/** Window size in seconds */
	window: number;
	/** Max requests per window */
	max: number;
}

const allStores: Map<string, number[]>[] = [];

/** Clear all rate limit state — used between tests */
export function resetRateLimiters() {
	for (const store of allStores) store.clear();
}

/**
 * In-memory sliding window rate limiter keyed by client IP.
 * Entries are lazily pruned on each request — no timers needed.
 */
export function rateLimiter(opts: RateLimitOpts) {
	const hits = new Map<string, number[]>();
	allStores.push(hits);

	return async (c: Context, next: Next) => {
		const key = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
		const now = Date.now();
		const windowMs = opts.window * 1000;

		const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

		if (timestamps.length >= opts.max) {
			c.header("Retry-After", String(opts.window));
			return c.json({ error: "Too many requests." }, 429);
		}

		timestamps.push(now);
		hits.set(key, timestamps);

		// Lazy cleanup: drop stale keys every ~100 requests
		if (hits.size > 1000) {
			for (const [k, ts] of hits) {
				const fresh = ts.filter((t) => now - t < windowMs);
				if (fresh.length === 0) hits.delete(k);
				else hits.set(k, fresh);
			}
		}

		return next();
	};
}
