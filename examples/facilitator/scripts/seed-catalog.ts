import dotenv from "dotenv";

dotenv.config();

import { extractDiscoveryInfo } from "@x402/extensions/bazaar";

import { Env } from "../src/config/env.js";
import { createMiniLmEmbedder, warmEmbedder } from "../src/modules/catalog/embedder.js";
import { SEED_CORPUS, seedPayloadOf } from "../tests/fixtures/seed-corpus.js";
import { toCatalogRecord } from "../src/modules/catalog/record.js";
import { CatalogStore } from "../src/modules/catalog/store.js";

/**
 * Fills the catalog with the synthetic demo corpus.
 *
 * Every entry goes through `extractDiscoveryInfo` and the ordinary upsert, the
 * same path a settlement takes, so the seeded rows are indistinguishable in
 * shape from observed ones. They are marked `source = 'seed'`, which is stored
 * but never served.
 */
async function main(): Promise<void> {
  const databaseUrl = Env.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the catalog");
  }

  const embedder = createMiniLmEmbedder();
  process.stdout.write("Loading the embedding model...\n");
  await warmEmbedder(embedder);

  const store = CatalogStore.connect(databaseUrl, embedder);
  await store.ensureSchema();

  let seeded = 0;
  let skipped = 0;

  for (const entry of SEED_CORPUS) {
    const { paymentPayload, requirements } = seedPayloadOf(entry);
    const discovered = extractDiscoveryInfo(paymentPayload, requirements);

    if (!discovered) {
      process.stderr.write(`  skipped (extraction rejected it): ${entry.resource}\n`);
      skipped += 1;
      continue;
    }

    await store.upsert(toCatalogRecord(discovered, requirements, "seed"));

    seeded += 1;
    process.stdout.write(`  ${discovered.resourceUrl}\n`);
  }

  await store.close();
  process.stdout.write(
    `\nSeeded ${seeded} resources${skipped > 0 ? `, skipped ${skipped}` : ""}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Seeding failed: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
