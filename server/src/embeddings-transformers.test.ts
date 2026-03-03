import { describe, expect, test } from "bun:test";
import { TransformersProvider } from "./embeddings-transformers.js";

// Integration test — downloads the model on first run (~23MB).
// Set HUSK_EMBEDDINGS_TEST=1 to run, skipped by default to keep CI fast.
const runIntegration = process.env.HUSK_EMBEDDINGS_TEST === "1";

describe.if(runIntegration)("TransformersProvider", () => {
	test("produces 384-dimensional embeddings", async () => {
		const provider = new TransformersProvider();
		expect(provider.name).toBe("transformers");
		expect(provider.dimensions).toBe(384);

		const vector = await provider.embed("hello world");
		expect(vector).toHaveLength(384);
		// Should be normalized (L2 norm ≈ 1)
		const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
		expect(norm).toBeCloseTo(1.0, 1);
	}, 60_000);

	test("different texts produce different embeddings", async () => {
		const provider = new TransformersProvider();
		const v1 = await provider.embed("refactored the authentication middleware");
		const v2 = await provider.embed("went to the grocery store");

		// Cosine similarity should be low for unrelated texts
		const dot = v1.reduce((sum, a, i) => sum + a * (v2[i] ?? 0), 0);
		expect(dot).toBeLessThan(0.5);
	}, 60_000);
});
