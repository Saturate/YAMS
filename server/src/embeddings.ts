import { getLogger } from "@logtape/logtape";

const log = getLogger(["yams", "embeddings"]);

export interface EmbeddingProvider {
	embed(text: string): Promise<number[]>;
	readonly dimensions: number;
	readonly name: string;
}

interface OllamaEmbedResponse {
	embeddings: number[][];
}

class OllamaProvider implements EmbeddingProvider {
	private readonly url: string;
	private readonly model: string;
	private cachedDimensions: number | null = null;

	readonly name = "ollama";

	constructor() {
		this.url = process.env.OLLAMA_URL ?? "http://localhost:11434";
		this.model = process.env.OLLAMA_MODEL ?? "nomic-embed-text";
	}

	get dimensions(): number {
		if (this.cachedDimensions) return this.cachedDimensions;
		return Number(process.env.EMBEDDING_DIMENSIONS) || 768;
	}

	async embed(text: string): Promise<number[]> {
		const res = await fetch(`${this.url}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: this.model, input: text }),
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Ollama embed failed (${res.status}): ${body}`);
		}

		const data = (await res.json()) as OllamaEmbedResponse;
		const embedding = data.embeddings[0];

		if (!embedding) {
			throw new Error("Ollama returned empty embeddings");
		}

		this.cachedDimensions = embedding.length;
		return embedding;
	}
}

let provider: EmbeddingProvider | null = null;

export function getProvider(): EmbeddingProvider {
	if (!provider) {
		provider = new OllamaProvider();
	}
	return provider;
}

export function setProvider(p: EmbeddingProvider) {
	provider = p;
}

export async function checkOllamaModel(): Promise<void> {
	const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
	const model = process.env.OLLAMA_MODEL ?? "nomic-embed-text";

	try {
		const res = await fetch(`${url}/api/tags`);
		if (!res.ok) return;

		const data = (await res.json()) as { models?: Array<{ name: string }> };
		const models = data.models ?? [];
		const hasModel = models.some((m) => m.name === model || m.name.startsWith(`${model}:`));

		if (!hasModel) {
			log.warn("Ollama model {model} is not pulled yet — run: ollama pull {model}", { model });
		}
	} catch {
		log.warn("Ollama is not reachable at {url} — embeddings will fail until it's running", {
			url,
		});
	}
}
