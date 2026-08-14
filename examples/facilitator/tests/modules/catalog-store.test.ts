import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { CatalogStore, resourceKey } from "../../src/modules/catalog/store.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../../src/modules/catalog/embedder.js";
import { PRICE_MAX_AGE_MS } from "../../src/modules/prices/index.js";

/**
 * A deterministic stand-in for MiniLM. Three topic axes are scored by how many
 * of their words the text uses, so similarity is graded rather than on/off --
 * enough to order results without paying the model load in every ranking test.
 * The real embedder has its own tests.
 */
const TOPIC_AXES = [
  /\b(weather|forecast|temperature|rain|climate|hourly)\b/g,
  /\b(city|address|coordinates|geocode|street|map|place)\b/g,
  /\b(guide|news|headline|offers|records|data)\b/g,
];

function fakeEmbedder(): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const lower = text.toLowerCase();
      const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
      TOPIC_AXES.forEach((axis, index) => {
        vector[index] = (lower.match(axis) ?? []).length;
      });
      // Cosine distance is undefined for a zero vector, so text on no axis gets
      // a direction of its own rather than none at all.
      const norm = Math.hypot(...vector);
      if (norm === 0) {
        vector[TOPIC_AXES.length] = 1;
        return vector;
      }
      return vector.map((value) => value / norm);
    },
  };
}

/**
 * These tests need a real Postgres with pgvector; they exercise SQL that no
 * stub can stand in for (generated tsvector columns, HNSW ranking, RRF). They
 * are skipped unless CATALOG_TEST_DATABASE_URL points at one, which keeps
 * `pnpm test` fast and database-free:
 *
 *   docker compose up -d postgres
 *   CATALOG_TEST_DATABASE_URL=postgres://facilitator:facilitator@localhost:5442/facilitator \
 *     pnpm test
 */
const TEST_DATABASE_URL = process.env.CATALOG_TEST_DATABASE_URL;

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CUSDC",
  amount: "1000",
  payTo: "GMERCHANT",
  maxTimeoutSeconds: 300,
  extra: {},
};

describe.skipIf(!TEST_DATABASE_URL)("CatalogStore against Postgres", () => {
  let store: CatalogStore;

  beforeAll(async () => {
    store = CatalogStore.connect(TEST_DATABASE_URL!, fakeEmbedder());
    await store.dropSchemaForTests();
    await store.ensureSchema();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.truncateForTests();
  });

  it("round-trips an http resource including its endpoint shape", async () => {
    await store.upsert({
      resource: "https://api.example.com/weather/:network",
      type: "http",
      method: "GET",
      routeTemplate: "/weather/:network",
      x402Version: 2,
      accepts: [requirements],
      extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
      description: "Weather forecast",
      serviceName: "Stellar Weather",
      tags: ["weather", "forecast"],
    });

    const { items, total } = await store.list({ limit: 10, offset: 0 });

    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      resource: "https://api.example.com/weather/:network",
      type: "http",
      x402Version: 2,
      accepts: [requirements],
      description: "Weather forecast",
      serviceName: "Stellar Weather",
      tags: ["weather", "forecast"],
      extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
    });
    expect(items[0].lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("gives each MCP tool sharing one endpoint its own row", async () => {
    const base = {
      resource: "https://mcp.example.com/rpc",
      type: "mcp",
      x402Version: 2,
      accepts: [requirements],
    };
    await store.upsert({ ...base, toolName: "get_weather", serviceName: "Weather Tool" });
    await store.upsert({ ...base, toolName: "get_forecast", serviceName: "Forecast Tool" });

    const { items, total } = await store.list({ limit: 10, offset: 0 });

    expect(total).toBe(2);
    expect(items.map((i) => i.serviceName).sort()).toEqual(["Forecast Tool", "Weather Tool"]);
  });

  it("updates in place when the same endpoint and tool settle again", async () => {
    const record = {
      resource: "https://api.example.com/weather",
      type: "http",
      method: "GET",
      x402Version: 2,
      accepts: [requirements],
      serviceName: "First Name",
    };
    await store.upsert(record);
    await store.upsert({ ...record, serviceName: "Second Name" });

    const { items, total } = await store.list({ limit: 10, offset: 0 });

    expect(total).toBe(1);
    expect(items[0].serviceName).toBe("Second Name");
  });

  it("merges accepts by asset, replacing the same asset and appending new ones", async () => {
    const record = {
      resource: "https://api.example.com/weather",
      type: "http",
      method: "GET",
      x402Version: 2,
      accepts: [requirements],
    };
    await store.upsert(record);
    // Same asset, fresh amount: replaces.
    await store.upsert({ ...record, accepts: [{ ...requirements, amount: "2000" }] });
    // Different asset: appends.
    await store.upsert({ ...record, accepts: [{ ...requirements, asset: "XLM", amount: "50" }] });

    const { items } = await store.list({ limit: 10, offset: 0 });

    expect(items[0].accepts).toEqual([
      expect.objectContaining({ asset: "CUSDC", amount: "2000" }),
      expect.objectContaining({ asset: "XLM", amount: "50" }),
    ]);
  });

  describe("settlement history", () => {
    const resource = "https://api.example.com/weather";
    const mcpResource = "https://mcp.example.com/rpc";

    beforeEach(async () => {
      await store.upsert({
        resource,
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
      });
    });

    it("counts calls and distinct payers over the last 30 days", async () => {
      await store.appendSettlement({ resource, asset: "CUSDC", payer: "GALICE" });
      await store.appendSettlement({ resource, asset: "CUSDC", payer: "GALICE" });
      await store.appendSettlement({ resource, asset: "CUSDC", payer: "GBOB" });

      const quality = await store.quality([{ resource }]);
      const entry = quality.get(resourceKey({ resource }))!;

      expect(entry).toMatchObject({ l30DaysTotalCalls: 3, l30DaysUniquePayers: 2 });
      expect(entry.lastCalledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("ignores settlements older than 30 days in the call counts", async () => {
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await store.appendSettlement({ resource, asset: "CUSDC", payer: "GOLD", settledAt: longAgo });
      await store.appendSettlement({ resource, asset: "CUSDC", payer: "GNEW" });

      const quality = await store.quality([{ resource }]);

      expect(quality.get(resourceKey({ resource }))).toMatchObject({
        l30DaysTotalCalls: 1,
        l30DaysUniquePayers: 1,
      });
    });

    it("keeps each MCP tool's history separate", async () => {
      await store.upsert({
        resource: mcpResource,
        toolName: "get_weather",
        type: "mcp",
        x402Version: 2,
        accepts: [requirements],
      });
      await store.appendSettlement({
        resource: mcpResource,
        toolName: "get_weather",
        asset: "CUSDC",
        payer: "GALICE",
      });
      await store.appendSettlement({ resource, asset: "CUSDC", payer: "GALICE" });

      const quality = await store.quality([
        { resource },
        { resource: mcpResource, toolName: "get_weather" },
      ]);

      expect(quality.get(resourceKey({ resource }))!.l30DaysTotalCalls).toBe(1);
      const mcpKey = resourceKey({ resource: mcpResource, toolName: "get_weather" });
      expect(quality.get(mcpKey)!.l30DaysTotalCalls).toBe(1);
    });

    it("reports no quality for a resource nobody has paid", async () => {
      const quality = await store.quality([{ resource }]);
      expect(quality.get(resourceKey({ resource }))).toBeUndefined();
    });

    it("leaves no resource row behind when logging the settlement fails", async () => {
      await store.truncateForTests();

      await expect(
        store.upsertWithSettlement(
          {
            resource: "https://api.example.com/new",
            type: "http",
            method: "GET",
            x402Version: 2,
            accepts: [requirements],
          },
          // `asset` is NOT NULL, so the settlement insert fails and must take
          // the resource row down with it.
          { resource: "https://api.example.com/new", asset: null as unknown as string },
        ),
      ).rejects.toThrow();

      const { total } = await store.list({ limit: 10, offset: 0 });
      expect(total).toBe(0);
    });
  });

  describe("filters", () => {
    const usdc = { ...requirements, asset: "CUSDC", amount: "1000" };
    const xlm = { ...requirements, asset: "XLM", amount: "50" };

    beforeEach(async () => {
      await store.upsert({
        resource: "https://weather.example.com/forecast",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [usdc],
        serviceName: "Weather Co",
        tags: ["weather", "forecast"],
        extensions: { bazaar: { info: {} } },
      });
      await store.upsert({
        resource: "https://maps.example.com/geocode",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [xlm],
        serviceName: "Maps Co",
        tags: ["maps", "geocoding"],
      });
      await store.upsert({
        resource: "https://mcp.example.com/rpc",
        toolName: "lookup",
        type: "mcp",
        x402Version: 2,
        accepts: [usdc],
        serviceName: "MCP Co",
      });
      // Priced in an asset none of the asset filters name, so an any-of filter
      // has something to exclude.
      await store.upsert({
        resource: "https://news.example.com/headlines",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [{ ...requirements, asset: "CEURC", amount: "900" }],
        serviceName: "News Co",
      });
    });

    async function resources(filters: Partial<Parameters<typeof store.list>[0]> = {}) {
      const { items } = await store.list({ limit: 20, offset: 0, ...filters });
      return items.map((i) => i.resource).sort();
    }

    it("filters by protocol type", async () => {
      expect(await resources({ type: "mcp" })).toEqual(["https://mcp.example.com/rpc"]);
    });

    it("filters by a single asset", async () => {
      expect(await resources({ asset: ["XLM"] })).toEqual(["https://maps.example.com/geocode"]);
    });

    it("treats a comma-separated asset list as any-of", async () => {
      expect(await resources({ asset: ["XLM", "CUSDC"] })).toHaveLength(3);
    });

    it("filters by maxAmount in the asset's own atomic units", async () => {
      expect(await resources({ asset: ["XLM"], maxAmount: "100" })).toEqual([
        "https://maps.example.com/geocode",
      ]);
      expect(await resources({ asset: ["XLM"], maxAmount: "10" })).toEqual([]);
    });

    it("ignores maxAmount when more than one asset is named", async () => {
      // Atomic units are per-asset, so a single ceiling across assets is
      // meaningless. The route rejects this combination; the store drops it.
      expect(await resources({ asset: ["XLM", "CUSDC"], maxAmount: "10" })).toHaveLength(3);
    });

    it("filters by tag", async () => {
      expect(await resources({ tags: ["forecast"] })).toEqual([
        "https://weather.example.com/forecast",
      ]);
    });

    it("filters by a substring of the resource url", async () => {
      expect(await resources({ urlSubstring: "maps." })).toEqual([
        "https://maps.example.com/geocode",
      ]);
    });

    it("filters by the presence of an extension key", async () => {
      expect(await resources({ extensions: "bazaar" })).toEqual([
        "https://weather.example.com/forecast",
      ]);
    });
  });

  /**
   * The ceiling is a predicate rather than a pass over fetched rows, so an
   * affordable resource ranked below the page can still be reached. These run
   * against real rates in asset_usd_prices for that reason.
   */
  describe("maxUsdPrice", () => {
    // 1 USDC = $1 and 1 XLM = $0.16, at 7 decimals.
    async function saveRates(fetchedAt = new Date()) {
      await store.savePrices([
        { asset: "CUSDC", coingeckoId: "usd-coin", usdPrice: "1", fetchedAt },
        { asset: "XLM", coingeckoId: "stellar", usdPrice: "0.16", fetchedAt },
      ]);
    }

    async function seedPriced() {
      await store.upsert({
        resource: "https://cheap.example.com/a",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [{ ...requirements, asset: "CUSDC", amount: "10000" }], // $0.001
      });
      await store.upsert({
        resource: "https://dear.example.com/b",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [{ ...requirements, asset: "CUSDC", amount: "1000000" }], // $0.10
      });
      await store.upsert({
        resource: "https://xlm.example.com/c",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [{ ...requirements, asset: "XLM", amount: "300000" }], // $0.0048
      });
      await store.upsert({
        resource: "https://unmapped.example.com/d",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [{ ...requirements, asset: "CMYSTERY", amount: "1" }],
      });
    }

    async function underCeiling(maxUsdPrice: number) {
      const { items } = await store.list({ limit: 20, offset: 0, maxUsdPrice });
      return items.map((i) => i.resource).sort();
    }

    beforeEach(async () => {
      await saveRates();
      await seedPriced();
    });

    it("drops a resource priced above the ceiling", async () => {
      expect(await underCeiling(0.01)).not.toContain("https://dear.example.com/b");
    });

    it("keeps a resource priced below the ceiling", async () => {
      expect(await underCeiling(0.01)).toContain("https://cheap.example.com/a");
    });

    it("converts a non-usd asset through its stored rate", async () => {
      expect(await underCeiling(0.01)).toContain("https://xlm.example.com/c");
      expect(await underCeiling(0.001)).not.toContain("https://xlm.example.com/c");
    });

    it("keeps a resource whose asset has no rate rather than hiding it", async () => {
      expect(await underCeiling(0.01)).toContain("https://unmapped.example.com/d");
    });

    it("judges a resource by its cheapest priceable option", async () => {
      await store.upsert({
        resource: "https://multi.example.com/e",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [
          { ...requirements, asset: "CUSDC", amount: "1000000" }, // $0.10
          { ...requirements, asset: "XLM", amount: "300000" }, // $0.0048
        ],
      });

      expect(await underCeiling(0.01)).toContain("https://multi.example.com/e");
    });

    it("treats a rate older than the max age as no rate at all", async () => {
      await store.truncateForTests();
      await saveRates(new Date(Date.now() - PRICE_MAX_AGE_MS - 60_000));
      await seedPriced();

      // Every rate is stale, so nothing is priceable and nothing is hidden.
      expect(await underCeiling(0.01)).toContain("https://dear.example.com/b");
    });

    it("reaches an affordable resource that ranks below the requested page", async () => {
      // The defect this replaced: the ceiling ran over rows the ranking had
      // already truncated, so a cheap match below the cut was never fetched.
      //
      // Every row here carries the same description, so ranking falls to the
      // resource url tiebreak. The names put the expensive rows first on purpose:
      // without the ceiling as a predicate, the cheap one sits below the page.
      for (let index = 0; index < 12; index += 1) {
        await store.upsert({
          resource: `https://aaa-dear-${index}.example.com/forecast`,
          type: "http",
          method: "GET",
          x402Version: 2,
          accepts: [{ ...requirements, asset: "CUSDC", amount: "1000000" }], // $0.10
          description: "hourly weather forecast for a city",
        });
      }
      await store.upsert({
        resource: "https://zzz-cheap.example.com/forecast",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [{ ...requirements, asset: "CUSDC", amount: "10000" }], // $0.001
        description: "hourly weather forecast for a city",
      });

      const unfiltered = await store.search("hourly weather forecast for a city", {}, 5);
      expect(unfiltered.map((h) => h.resource)).not.toContain(
        "https://zzz-cheap.example.com/forecast",
      );

      const hits = await store.search(
        "hourly weather forecast for a city",
        { maxUsdPrice: 0.01 },
        5,
      );
      expect(hits.map((h) => h.resource)).toContain("https://zzz-cheap.example.com/forecast");
    });
  });

  describe("lexical arm", () => {
    beforeEach(async () => {
      await store.upsert({
        resource: "https://weather.example.com/forecast",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Stellar Weather",
        description: "Hourly weather forecast for any city",
        tags: ["weather", "forecast"],
      });
      await store.upsert({
        resource: "https://maps.example.com/geocode",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Maps Co",
        description: "Turn an address into coordinates",
        tags: ["maps", "geocoding"],
      });
    });

    it("matches a natural-language query that shares only some terms", async () => {
      // plainto_tsquery and websearch_to_tsquery both AND their lexemes, which
      // would make this query match nothing and leave "hybrid" search
      // vector-only. Terms must be OR-ed and ranked instead.
      const hits = await store.searchLexical("current weather for a city", {}, 10);

      expect(hits.map((h) => h.resource)).toContain("https://weather.example.com/forecast");
      expect(hits[0].resource).toBe("https://weather.example.com/forecast");
    });

    it("ranks the better lexical match first", async () => {
      const hits = await store.searchLexical("address coordinates geocoding", {}, 10);
      expect(hits[0].resource).toBe("https://maps.example.com/geocode");
    });

    it("returns nothing when no term matches", async () => {
      const hits = await store.searchLexical("zzzznonexistentterm", {}, 10);
      expect(hits).toEqual([]);
    });

    it("applies filters as hard constraints inside the arm", async () => {
      const hits = await store.searchLexical("weather forecast city", { type: "mcp" }, 10);
      expect(hits).toEqual([]);
    });
  });

  describe("vector arm", () => {
    beforeEach(async () => {
      // The fake embedder keys off the word "weather", so these two rows sit at
      // opposite ends of the one meaningful dimension.
      await store.upsert({
        resource: "https://weather.example.com/forecast",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Stellar Weather",
        description: "Hourly weather forecast for any city",
      });
      await store.upsert({
        resource: "https://maps.example.com/geocode",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Maps Co",
        description: "Turn an address into coordinates",
      });
    });

    it("ranks by cosine distance to the query embedding", async () => {
      const hits = await store.searchVector("what is the weather", {}, 10);
      expect(hits[0].resource).toBe("https://weather.example.com/forecast");
    });

    it("ranks the other way for a query on the opposite side", async () => {
      const hits = await store.searchVector("street address lookup", {}, 10);
      expect(hits[0].resource).toBe("https://maps.example.com/geocode");
    });

    it("applies filters as hard constraints inside the arm", async () => {
      const hits = await store.searchVector("what is the weather", { type: "mcp" }, 10);
      expect(hits).toEqual([]);
    });

    it("skips rows whose embedding has not been filled in", async () => {
      // A reachable state once embedding moves off the settle path into a
      // background sweep of NULL rows.
      await store.clearEmbeddingsForTests();

      const hits = await store.searchVector("what is the weather", {}, 10);
      expect(hits).toEqual([]);
    });
  });

  describe("hybrid search", () => {
    beforeEach(async () => {
      // Strong on both arms: the words match and the fake embedder puts it on
      // the weather axis.
      await store.upsert({
        resource: "https://weather.example.com/forecast",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Stellar Weather",
        description: "Hourly weather forecast for any city",
        tags: ["weather", "forecast"],
      });
      // Shares the query's "city" but none of its weather wording, so it places
      // behind on both arms rather than tying.
      await store.upsert({
        resource: "https://blog.example.com/city-guide",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "City Guide",
        description: "A guide to what a city offers",
      });
      // Semantic only: on the weather axis with none of the query's wording.
      await store.upsert({
        resource: "https://climate.example.com/data",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Climate Data",
        description: "Long-run temperature and rain records",
      });
    });

    it("ranks a resource strong on both arms above one strong on either alone", async () => {
      const hits = await store.search("current weather for a city", {}, 10);

      expect(hits[0].resource).toBe("https://weather.example.com/forecast");
    });

    it("lets agreement between arms outweigh a better placing in one", async () => {
      // The climate service is the closer semantic match of the two, but has
      // none of the query's words. The city guide is weaker semantically and
      // stronger lexically. Appearing in both arms is what wins.
      const found = (await store.search("current weather for a city", {}, 10)).map(
        (h) => h.resource,
      );

      expect(found.indexOf("https://blog.example.com/city-guide")).toBeLessThan(
        found.indexOf("https://climate.example.com/data"),
      );
    });

    it("returns resources that only one arm found", async () => {
      const found = (await store.search("current weather for a city", {}, 10)).map(
        (h) => h.resource,
      );

      expect(found).toContain("https://blog.example.com/city-guide");
      expect(found).toContain("https://climate.example.com/data");
    });

    it("applies filters as hard constraints, not as a trim after ranking", async () => {
      const hits = await store.search("current weather for a city", { type: "mcp" }, 10);
      expect(hits).toEqual([]);
    });

    it("honours the result limit", async () => {
      const hits = await store.search("current weather for a city", {}, 2);
      expect(hits).toHaveLength(2);
    });

    it("does not return the same resource twice when both arms find it", async () => {
      const hits = await store.search("weather forecast city", {}, 10);
      const keys = hits.map((h) => h.resource);

      expect(new Set(keys).size).toBe(keys.length);
    });

    it("attaches each MCP tool's own usage signals", async () => {
      const mcp = "https://mcp.example.com/rpc";
      for (const toolName of ["get_weather", "get_forecast"]) {
        await store.upsert({
          resource: mcp,
          toolName,
          type: "mcp",
          x402Version: 2,
          accepts: [requirements],
          serviceName: "Weather Tools",
          description: `Weather forecast tool ${toolName}`,
        });
      }
      await store.appendSettlement({ resource: mcp, toolName: "get_weather", asset: "CUSDC" });

      const hits = await store.search("weather forecast", { type: "mcp" }, 10);
      const byTool = new Map(hits.map((h) => [h.toolName, h]));

      // Tool-level history: one was paid for, its sibling on the same endpoint
      // was not.
      expect(byTool.get("get_weather")?.quality?.l30DaysTotalCalls).toBe(1);
      expect(byTool.get("get_forecast")?.quality).toBeUndefined();
    });

    it("still ranks when only the lexical arm can contribute", async () => {
      await store.clearEmbeddingsForTests();

      const hits = await store.search("weather forecast", {}, 10);
      expect(hits[0].resource).toBe("https://weather.example.com/forecast");
    });
  });

  it("is safe to run ensureSchema again on a populated database", async () => {
    await store.upsert({
      resource: "https://api.example.com/weather",
      type: "http",
      method: "GET",
      x402Version: 2,
      accepts: [requirements],
    });

    await store.ensureSchema();

    const { total } = await store.list({ limit: 10, offset: 0 });
    expect(total).toBe(1);
  });
});
