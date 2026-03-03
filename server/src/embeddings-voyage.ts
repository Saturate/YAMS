import { getLogger } from "@logtape/logtape";
import type { EmbeddingProvider } from "./embeddings.js";

const log = getLogger(["husk", "embeddings-voyage"]);

const FETCH_TIMEOUT_MS = 30_000;

interface VoyageEmbedResponse {
	data: Array<{ embedding: number[]; index: number }>;
	usage: { total_tokens: number };
}

export class VoyageProvider implements EmbeddingProvider {
	readonly name = "voyage";
	readonly dimensions: number;
	private readonly model: string;
	private readonly apiKey: string;

	constructor() {
		const key = process.env.HUSK_EMBED_API_KEY;
		if (!key) {
			throw new Error("HUSK_EMBED_API_KEY is required for the Voyage embedding provider");
		}
		this.apiKey = key;
		this.model = process.env.HUSK_EMBED_MODEL ?? "voyage-3.5";
		this.dimensions = Number(process.env.HUSK_EMBED_DIMENSIONS) || 1024;
	}

	async embed(text: string): Promise<number[]> {
		const res = await fetch("https://api.voyageai.com/v1/embeddings", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				input: [text],
				model: this.model,
				// Voyage recommends specifying input_type for retrieval quality.
				// Memories are documents; queries happen at search time.
				// Since we embed one text at a time and can't distinguish here,
				// omit input_type to use the general-purpose mode.
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Voyage embed failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as VoyageEmbedResponse;
		const embedding = data.data[0]?.embedding;

		if (!embedding) {
			throw new Error("Voyage returned empty embeddings");
		}

		if (data.usage) {
			log.debug("Voyage embed used {tokens} tokens", { tokens: data.usage.total_tokens });
		}

		return embedding;
	}
}
