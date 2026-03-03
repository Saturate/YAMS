import { getLogger } from "@logtape/logtape";
import type { EmbeddingProvider } from "./embeddings.js";

const log = getLogger(["husk", "embeddings-transformers"]);

// Model defaults — small, fast, good quality for semantic search
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIMS = 384;

type FeatureExtractionPipeline = (
	texts: string[],
	options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class TransformersProvider implements EmbeddingProvider {
	readonly name = "transformers";
	readonly dimensions: number;
	private readonly model: string;
	private pipeline: FeatureExtractionPipeline | null = null;
	private loading: Promise<FeatureExtractionPipeline> | null = null;

	constructor() {
		this.model = process.env.HUSK_EMBED_MODEL ?? DEFAULT_MODEL;
		this.dimensions = Number(process.env.EMBEDDING_DIMENSIONS) || DEFAULT_DIMS;
	}

	async embed(text: string): Promise<number[]> {
		const pipe = await this.getPipeline();
		const output = await pipe([text], { pooling: "mean", normalize: true });
		const vectors = output.tolist();
		const embedding = vectors[0];
		if (!embedding) {
			throw new Error("Transformers.js returned empty embeddings");
		}
		return embedding;
	}

	private async getPipeline(): Promise<FeatureExtractionPipeline> {
		if (this.pipeline) return this.pipeline;

		// Avoid multiple concurrent loads
		if (!this.loading) {
			this.loading = this.loadPipeline();
		}
		this.pipeline = await this.loading;
		return this.pipeline;
	}

	private async loadPipeline(): Promise<FeatureExtractionPipeline> {
		log.info("Loading embedding model {model} (first call downloads ~23MB)...", {
			model: this.model,
		});

		const { pipeline, env } = await import("@huggingface/transformers");

		// Cache models alongside other HUSK data
		env.cacheDir = process.env.HUSK_MODELS_PATH ?? "data/models";

		const pipe = await pipeline("feature-extraction", this.model, {
			dtype: "q8",
		});

		log.info("Embedding model loaded ({model})", { model: this.model });
		return pipe as unknown as FeatureExtractionPipeline;
	}
}
