import dotenv from "dotenv";

dotenv.config();

import { Env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createApp } from "./app.js";
import { createCatalogModule, type CatalogModule } from "./modules/catalog/index.js";
import { CatalogStore } from "./modules/catalog/store.js";
import { createMiniLmEmbedder, warmEmbedder } from "./modules/catalog/embedder.js";
import { createPriceFeed, type PriceFeed } from "./modules/prices/index.js";

async function main() {
  let catalog: CatalogModule | undefined;
  let prices: PriceFeed | undefined;
  const databaseUrl = Env.databaseUrl;
  if (databaseUrl) {
    // Warmed before serving so a missing model is a startup failure rather than
    // a first-query failure.
    const embedder = createMiniLmEmbedder();
    await warmEmbedder(embedder);

    const store = CatalogStore.connect(databaseUrl, embedder);
    await store.ensureSchema();

    prices = createPriceFeed({ store, apiKey: Env.coingeckoApiKey });
    await prices.load();
    await prices.refresh();
    prices.start();

    catalog = createCatalogModule(store, prices);
    logger.info("Catalog module enabled (Postgres, pgvector, MiniLM embeddings)");
  } else {
    logger.info("Catalog module disabled (no DATABASE_URL)");
  }

  const app = createApp(catalog);

  const server = app.listen(Env.port, () => {
    logger.info({ port: Env.port }, "Stellar Facilitator listening");
  });

  function shutdown(signal: string) {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    const forceExit = setTimeout(() => {
      logger.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      prices?.stop();
      const closeCatalog = catalog ? catalog.close() : Promise.resolve();
      closeCatalog
        .catch((err) => logger.error({ err }, "Catalog close failed"))
        .finally(() => {
          logger.info("Server closed");
          logger.flush();
          process.exit(0);
        });
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "Startup failed");
  process.exit(1);
});
