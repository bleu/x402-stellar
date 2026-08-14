/** all-MiniLM-L6-v2 output width. The embedding column is declared to match. */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Turns text into a vector for semantic ranking. Injected into the store so
 * ranking tests can use a cheap deterministic stand-in: with the real model, a
 * failing ranking test cannot tell a bad SQL join from a bad embedding.
 */
export interface Embedder {
  /** Returns an L2-normalised vector of EMBEDDING_DIMENSIONS values. */
  embed(text: string): Promise<number[]>;
}

/** pgvector's text input format. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Quantised weights: a quarter of the size at negligible ranking cost here. */
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/**
 * Local MiniLM embedder. No API key and no network at request time: the
 * Dockerfile prefetches the weights, and startup warms the singleton so a
 * missing model fails at boot rather than on the first query.
 */
export function createMiniLmEmbedder(): Embedder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipe: Promise<any> | undefined;

  async function extractor() {
    if (!pipe) {
      pipe = import("@huggingface/transformers").then(({ pipeline }) =>
        pipeline("feature-extraction", MODEL_ID, { dtype: "q8" }),
      );
    }
    return pipe;
  }

  return {
    async embed(text: string): Promise<number[]> {
      const extract = await extractor();
      // Mean pooling over tokens, then L2 normalise, which is what this model
      // expects for cosine similarity.
      const output = await extract(text, { pooling: "mean", normalize: true });
      return Array.from(output.data as Float32Array);
    },
  };
}

/** Loads the model up front so a missing or broken model fails at startup. */
export async function warmEmbedder(embedder: Embedder): Promise<void> {
  await embedder.embed("warm up");
}
