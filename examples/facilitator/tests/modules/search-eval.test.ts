import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { extractDiscoveryInfo, declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { createCatalogModule, type UsdPrices } from "../../src/modules/catalog/index.js";
import { createMiniLmEmbedder, warmEmbedder } from "../../src/modules/catalog/embedder.js";
import { toCatalogRecord } from "../../src/modules/catalog/record.js";
import { SEED_CORPUS, seedPayloadOf } from "../../src/modules/catalog/seed-corpus.js";
import { CatalogStore } from "../../src/modules/catalog/store.js";
import { ASSET_DECIMALS, COINGECKO_IDS_BY_ASSET } from "../../src/modules/prices/index.js";

vi.mock("../../src/utils/logger.js", () => {
  const noop = () => {};
  const noopLogger = {
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    flush: noop,
    child: () => noopLogger,
  };
  return { logger: noopLogger, httpLogger: (_a: unknown, _b: unknown, next: () => void) => next() };
});

/**
 * Fixed rates through the real asset map, so the eval does not depend on
 * CoinGecko being reachable while still exercising the mapped-asset path.
 */
const USD_PER_COIN: Record<string, number> = { "usd-coin": 1, stellar: 0.16 };

const staticPrices: UsdPrices = {
  usdPriceOf(asset) {
    const id = COINGECKO_IDS_BY_ASSET.get(asset);
    return id ? (USD_PER_COIN[id] ?? null) : null;
  },
  atomicToUsd(asset, atomicAmount) {
    const price = this.usdPriceOf(asset);
    return price === null ? null : (Number(atomicAmount) / 10 ** ASSET_DECIMALS) * price;
  },
  hasAnyPrice: () => true,
};

/**
 * Ranking quality over the demo corpus, using the real MiniLM embeddings.
 *
 * The golden answers are our own, so this measures regression, not absolute
 * quality: it tells us a change made ranking worse than it was, and says
 * nothing about how good the ranking is next to any other system.
 */
const TEST_DATABASE_URL = process.env.CATALOG_TEST_DATABASE_URL;

/**
 * The live Phase-1 weather endpoint, as a real settlement would catalog it.
 *
 * These values mirror `buildApiRouteConfig` in
 * examples/simple-paywall/server/src/middleware/payment.ts; the paywall's own
 * tests pin them on that side.
 */
const DEMO_RESOURCE = "https://paywall.example/weather/:network";
const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function demoEndpointPayload() {
  const { bazaar } = declareDiscoveryExtension({
    input: { city: "San Francisco" },
    inputSchema: {
      properties: { city: { type: "string", description: "City name to look up" } },
      required: ["city"],
    },
    output: {
      example: {
        city: "San Francisco",
        country: "United States",
        current: { weather: "clear sky", temperature_f: 63.4, humidity_pct: 68 },
      },
    },
  });

  const requirements = {
    scheme: "exact",
    network: "stellar:testnet",
    asset: USDC_TESTNET,
    amount: "10000", // 0.001 USDC at 7 decimals
    payTo: "GDEMOMERCHANT",
    maxTimeoutSeconds: 300,
    extra: {},
  };

  return {
    requirements,
    paymentPayload: {
      x402Version: 2,
      resource: {
        url: "https://paywall.example/weather/testnet",
        description: "Current weather and temperature for any city by name",
        mimeType: "application/json",
        serviceName: "Stellar Weather",
        tags: ["weather", "forecast", "temperature", "city"],
      },
      accepted: requirements,
      extensions: {
        bazaar: {
          ...bazaar,
          info: { ...bazaar.info, input: { ...bazaar.info.input, method: "GET" } },
          routeTemplate: "/weather/:network",
        },
      },
      payload: {},
    },
  };
}

/** Query, and the resource a person would call the right answer. */
const GOLDEN_QUERIES: { query: string; expected: string }[] = [
  { query: "current weather for a city", expected: DEMO_RESOURCE },
  {
    query: "hourly weather forecast for the next week",
    expected: "https://api.forecastpro.example/hourly",
  },
  {
    query: "historical temperature and rainfall records",
    expected: "https://api.climatearchive.example/records",
  },
  {
    query: "turn a street address into coordinates",
    expected: "https://api.geocodr.example/v1/forward",
  },
  { query: "map tiles for a slippy map", expected: "https://api.tilehost.example/tiles/:z/:x/:y" },
  {
    query: "driving directions between two cities",
    expected: "https://api.routeplanner.example/directions",
  },
  { query: "stock price quote by ticker symbol", expected: "https://api.tickerfeed.example/quote" },
  { query: "convert between two currencies", expected: "https://api.fxrates.example/convert" },
  {
    query: "order book depth for a crypto pair",
    expected: "https://api.cryptodepth.example/orderbook",
  },
  {
    query: "translate text into another language",
    expected: "https://api.translately.example/v2/translate",
  },
  {
    query: "condense a long article into an abstract",
    expected: "https://api.summarise.example/article",
  },
  {
    query: "public holidays for a country and year",
    expected: "https://api.holidaycal.example/holidays",
  },
  {
    query: "airport runway elevation and timezone",
    expected: "https://api.airportdb.example/airport",
  },
  { query: "top news headlines by topic", expected: "https://api.newsdigest.example/headlines" },
];

describe.skipIf(!TEST_DATABASE_URL)("search evaluation", () => {
  let store: CatalogStore;

  beforeAll(async () => {
    const embedder = createMiniLmEmbedder();
    await warmEmbedder(embedder);

    store = CatalogStore.connect(TEST_DATABASE_URL!, embedder);
    await store.dropSchemaForTests();
    await store.ensureSchema();

    // The synthetic corpus, through the same door a settlement uses.
    for (const entry of SEED_CORPUS) {
      const { paymentPayload, requirements } = seedPayloadOf(entry);
      const discovered = extractDiscoveryInfo(paymentPayload, requirements)!;
      await store.upsert(toCatalogRecord(discovered, requirements, "seed"));
    }

    // Plus the live demo endpoint, which is what the done-when is about.
    const demo = demoEndpointPayload();
    const discovered = extractDiscoveryInfo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      demo.paymentPayload as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      demo.requirements as any,
    )!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await store.upsert(toCatalogRecord(discovered, demo.requirements as any));
  }, 180_000);

  afterAll(async () => {
    await store.close();
  });

  it("ranks the live weather endpoint first for the phase's done-when query", async () => {
    // The ticket's acceptance criterion, driven through the real route so the
    // maxUsdPrice filter and the response shape are part of what is proven.
    const app = express();
    app.use(createCatalogModule(store, staticPrices).router);

    const res = await request(app)
      .get("/discovery/search")
      .query({ query: "current weather for a city", maxUsdPrice: "0.01" });

    expect(res.status).toBe(200);
    expect(res.body.searchMethod).toBe("hybrid");
    expect(res.body.resources[0].resource).toBe(DEMO_RESOURCE);
  });

  it("prices out the rival that costs more than a cent", async () => {
    const app = express();
    app.use(createCatalogModule(store, staticPrices).router);

    const res = await request(app)
      .get("/discovery/search")
      .query({ query: "hourly weather forecast for the next week", maxUsdPrice: "0.01" });

    const found = res.body.resources.map((r: { resource: string }) => r.resource);
    // ForecastPro is the best answer to this query but costs $0.25.
    expect(found).not.toContain("https://api.forecastpro.example/hourly");
  });

  it("keeps the resource priced in an unmapped asset and says so", async () => {
    const app = express();
    app.use(createCatalogModule(store, staticPrices).router);

    const res = await request(app)
      .get("/discovery/search")
      .query({ query: "order book depth for a crypto pair", maxUsdPrice: "0.01" });

    const found = res.body.resources.map((r: { resource: string }) => r.resource);
    expect(found).toContain("https://api.cryptodepth.example/orderbook");
    expect(res.body.warnings).toEqual([expect.stringContaining("no USD rate")]);
  });

  it("beats the rival weather services on that query", async () => {
    const found = (await store.search("current weather for a city", {}, 20)).map((h) => h.resource);
    const demoRank = found.indexOf(DEMO_RESOURCE);

    expect(demoRank).toBeGreaterThanOrEqual(0);
    for (const rival of [
      "https://api.quickweather.example/v1/now",
      "https://meteo-anon.example/api/conditions",
    ]) {
      const rivalRank = found.indexOf(rival);
      if (rivalRank >= 0) expect(demoRank).toBeLessThan(rivalRank);
    }
  });

  it("finds the expected resource in the top three for most golden queries", async () => {
    const misses: string[] = [];

    for (const { query, expected } of GOLDEN_QUERIES) {
      const found = (await store.search(query, {}, 10)).map((hit) => hit.resource);
      const rank = found.indexOf(expected);
      if (rank < 0 || rank > 2)
        misses.push(`${query} -> ${rank < 0 ? "absent" : `rank ${rank + 1}`}`);
    }

    expect(misses, `golden queries outside the top three:\n${misses.join("\n")}`).toHaveLength(0);
  });

  it("holds mean reciprocal rank above 0.8 across the golden set", async () => {
    let reciprocalSum = 0;

    for (const { query, expected } of GOLDEN_QUERIES) {
      const found = (await store.search(query, {}, 10)).map((hit) => hit.resource);
      const rank = found.indexOf(expected);
      if (rank >= 0) reciprocalSum += 1 / (rank + 1);
    }

    const mrr = reciprocalSum / GOLDEN_QUERIES.length;
    // Currently 1.0: every golden query puts its expected resource first. That
    // says more about a 21-row corpus of topically distinct services than about
    // ranking quality, so treat the threshold as a tripwire for regressions
    // rather than as a score worth quoting.
    expect(mrr).toBeGreaterThan(0.8);
  });
});
