import { describe, it, expect, beforeAll } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  createMiniLmEmbedder,
  type Embedder,
} from "../../src/modules/catalog/embedder.js";

/**
 * Exercises the real all-MiniLM-L6-v2 model, so it needs the weights on disk
 * (or one download) and takes a few seconds. Gated on the same variable as the
 * database tests to keep `pnpm test` fast and offline.
 */
const ENABLED = Boolean(process.env.CATALOG_TEST_DATABASE_URL);

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

describe.skipIf(!ENABLED)("MiniLM embedder", () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = createMiniLmEmbedder();
    // Warm the lazy singleton once so the timing of individual cases is honest.
    await embedder.embed("warm up");
  }, 120_000);

  it("returns a unit vector of the model's width", async () => {
    const embedding = await embedder.embed("hourly weather forecast for any city");

    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(cosine(embedding, embedding)).toBeCloseTo(1, 5);
  });

  it("places related text closer than unrelated text", async () => {
    const query = await embedder.embed("what is the weather in a city");
    const weather = await embedder.embed("Stellar Weather. Hourly forecast for any city.");
    const geocoding = await embedder.embed("Maps Co. Turn a street address into coordinates.");

    expect(cosine(query, weather)).toBeGreaterThan(cosine(query, geocoding));
  });

  it("is deterministic for the same text", async () => {
    const first = await embedder.embed("current weather for a city");
    const second = await embedder.embed("current weather for a city");

    expect(cosine(first, second)).toBeCloseTo(1, 5);
  });
});
