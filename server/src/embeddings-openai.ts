import type { EmbeddingProvider } from "./embeddings.js";

const FETCH_TIMEOUT_MS = 30_000;

interface OpenAIEmbedResponse {
	data: Array<{ embedding: number[]; index: number }>;
}

/**
 * OpenAI-compatible embedding provider. Works with:
 * - OpenAI API (default)
 * - Azure OpenAI
 * - llama.cpp server (--embedding mode)
 * - Any service exposing POST /embeddings with the OpenAI schema
 */
export class OpenAICompatibleProvider implements EmbeddingProvider {
	readonly name: string;
	readonly dimensions: number;
	private readonly model: string;
	private readonly baseUrl: string;
	private readonly apiKey: string | null;

	constructor(options?: { name?: string; defaultBaseUrl?: string; defaultModel?: string }) {
		this.name = options?.name ?? "openai";
		this.baseUrl =
			process.env.HUSK_EMBED_URL ?? options?.defaultBaseUrl ?? "https://api.openai.com/v1";
		this.model = process.env.HUSK_EMBED_MODEL ?? options?.defaultModel ?? "text-embedding-3-small";
		this.apiKey = process.env.HUSK_EMBED_API_KEY ?? null;
		this.dimensions = Number(process.env.HUSK_EMBED_DIMENSIONS) || 1536;

		if (this.baseUrl.startsWith("https://api.openai.com") && !this.apiKey) {
			throw new Error("HUSK_EMBED_API_KEY is required for the OpenAI embedding provider");
		}
	}

	async embed(text: string): Promise<number[]> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`;
		}

		const res = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				input: text,
				model: this.model,
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`${this.name} embed failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as OpenAIEmbedResponse;
		const embedding = data.data[0]?.embedding;

		if (!embedding) {
			throw new Error(`${this.name} returned empty embeddings`);
		}

		return embedding;
	}
}
