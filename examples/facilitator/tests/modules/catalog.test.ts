import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { createCatalogModule } from "../../src/modules/catalog/index.js";
import type { CatalogStore } from "../../src/modules/catalog/store.js";

// A spy rather than a noop, so a test can tell a deliberate early return from an
// error the recorder swallowed on its way to the same outcome.
const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock("../../src/utils/logger.js", () => {
  const noop = () => {};
  const noopLogger = {
    info: noop,
    error: loggerError,
    warn: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    flush: noop,
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

function stubStore() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertWithSettlement: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    search: vi.fn().mockResolvedValue([]),
    quality: vi.fn().mockResolvedValue(new Map()),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as CatalogStore & {
    upsert: ReturnType<typeof vi.fn>;
    upsertWithSettlement: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    quality: ReturnType<typeof vi.fn>;
  };
}

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "100000",
  payTo: "GMERCHANT",
  maxTimeoutSeconds: 300,
  extra: {},
};

/**
 * A bazaar extension as it reaches the facilitator: declared by the resource
 * server, then enriched with `method` (and optionally `routeTemplate`) by
 * bazaarResourceServerExtension. Declaration alone omits `method`, which the
 * extension's own JSON Schema marks required.
 */
function enrichedBazaar(routeTemplate?: string) {
  const { bazaar } = declareDiscoveryExtension({
    input: { city: "San Francisco" },
    inputSchema: { properties: { city: { type: "string" } } },
    output: { example: { city: "San Francisco", tempC: 17 } },
  });
  return {
    bazaar: {
      ...bazaar,
      info: { ...bazaar.info, input: { ...bazaar.info.input, method: "GET" } },
      ...(routeTemplate ? { routeTemplate } : {}),
    },
  };
}

function settleContext(overrides: Record<string, unknown> = {}) {
  return {
    paymentPayload: {
      x402Version: 2,
      resource: {
        url: "https://api.example.com/weather?city=SF",
        description: "Weather",
        serviceName: "Weather API",
        tags: ["weather", "forecast"],
        iconUrl: "https://api.example.com/icon.png",
      },
      accepted: requirements,
      extensions: enrichedBazaar(),
      payload: {},
    },
    requirements,
    result: { success: true, transaction: "abc", network: "stellar:testnet" },
    ...overrides,
  };
}

describe("catalog module", () => {
  let store: ReturnType<typeof stubStore>;

  beforeEach(() => {
    store = stubStore();
    loggerError.mockClear();
  });

  it("records a bazaar-declaring settlement under its canonical resource url", async () => {
    const catalog = createCatalogModule(store);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(settleContext() as any);

    expect(store.upsertWithSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        // Query string dropped by extractDiscoveryInfo's canonicalisation.
        resource: "https://api.example.com/weather",
        type: "http",
        method: "GET",
        x402Version: 2,
        accepts: [requirements],
        serviceName: "Weather API",
        tags: ["weather", "forecast"],
      }),
      expect.anything(),
    );
  });

  it("logs the settlement alongside the resource so usage can be counted", async () => {
    const catalog = createCatalogModule(store);
    await catalog.recordSettlement(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settleContext({
        result: {
          success: true,
          transaction: "abc",
          network: "stellar:testnet",
          payer: "GPAYER",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );

    expect(store.upsertWithSettlement).toHaveBeenCalledWith(expect.anything(), {
      resource: "https://api.example.com/weather",
      toolName: undefined,
      asset: "CASSET",
      payer: "GPAYER",
    });
  });

  it("keys a templated route by its template, not the concrete path", async () => {
    const catalog = createCatalogModule(store);
    const context = settleContext();
    context.paymentPayload.resource.url = "https://api.example.com/weather/testnet";
    context.paymentPayload.extensions = enrichedBazaar("/weather/:network");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(context as any);

    expect(store.upsertWithSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://api.example.com/weather/:network",
        routeTemplate: "/weather/:network",
      }),
      expect.anything(),
    );
  });

  it("skips settlements whose payload declares no bazaar extension", async () => {
    const catalog = createCatalogModule(store);
    const context = settleContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (context.paymentPayload as any).extensions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(context as any);

    expect(store.upsertWithSettlement).not.toHaveBeenCalled();
    // Not storing is only half of it: the recorder must return early rather than
    // reach the extraction result and throw its way to the same silence.
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("skips settlements whose bazaar extension fails schema validation", async () => {
    const catalog = createCatalogModule(store);
    const context = settleContext();
    // `method` is required by the extension's own schema; a declaration that
    // never went through the resource server's enrichment lacks it.
    context.paymentPayload.extensions = declareDiscoveryExtension({
      input: { city: "San Francisco" },
      inputSchema: { properties: { city: { type: "string" } } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(context as any);

    expect(store.upsertWithSettlement).not.toHaveBeenCalled();
  });

  it("skips failed settlements", async () => {
    const catalog = createCatalogModule(store);
    await catalog.recordSettlement(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settleContext({ result: { success: false, transaction: "", network: "x" } }) as any,
    );

    expect(store.upsertWithSettlement).not.toHaveBeenCalled();
  });

  it("skips payloads without a resource url", async () => {
    const catalog = createCatalogModule(store);
    const context = settleContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (context.paymentPayload as any).resource;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(context as any);

    expect(store.upsertWithSettlement).not.toHaveBeenCalled();
  });

  it("does not throw when the store fails", async () => {
    store.upsertWithSettlement.mockRejectedValue(new Error("db down"));
    const catalog = createCatalogModule(store);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(catalog.recordSettlement(settleContext() as any)).resolves.toBeUndefined();
  });

  it("serves the discovery list shape with filters", async () => {
    store.list.mockResolvedValue({
      items: [
        {
          resource: "https://api.example.com/weather",
          type: "http",
          x402Version: 2,
          accepts: [requirements],
          lastUpdated: "2026-08-11T00:00:00.000Z",
        },
      ],
      total: 1,
    });

    const app = express();
    app.use(createCatalogModule(store).router);

    const res = await request(app)
      .get("/discovery/resources")
      .query({ scheme: "exact", network: "stellar:testnet", limit: "10" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      x402Version: 2,
      items: [
        expect.objectContaining({ resource: "https://api.example.com/weather", type: "http" }),
      ],
      pagination: { limit: 10, offset: 0, total: 1 },
    });
    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({
        scheme: "exact",
        network: "stellar:testnet",
        limit: 10,
        offset: 0,
      }),
    );
  });

  // The README lists maxUsdPrice as applying to both routes, and it only reached
  // search until the ceiling became a shared predicate.
  it("hands a usd ceiling on the list route to the store", async () => {
    const app = express();
    app.use(createCatalogModule(store).router);

    await request(app).get("/discovery/resources").query({ maxUsdPrice: "0.01" });

    expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ maxUsdPrice: 0.01 }));
  });

  it("keeps the internal tool name out of the list response", async () => {
    store.list.mockResolvedValue({
      items: [
        {
          resource: "https://mcp.example.com/rpc",
          type: "mcp",
          toolName: "get_weather",
          x402Version: 2,
          accepts: [requirements],
          lastUpdated: "2026-08-11T00:00:00.000Z",
        },
      ],
      total: 1,
    });

    const app = express();
    app.use(createCatalogModule(store).router);

    const res = await request(app).get("/discovery/resources");

    expect(res.body.items[0]).not.toHaveProperty("toolName");
    expect(res.body.items[0].resource).toBe("https://mcp.example.com/rpc");
  });

  it("clamps bad pagination input to defaults", async () => {
    const app = express();
    app.use(createCatalogModule(store).router);

    const res = await request(app)
      .get("/discovery/resources")
      .query({ limit: "-5", offset: "nope" });

    expect(res.status).toBe(200);
    expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, offset: 0 }));
  });
});

describe("discovery search", () => {
  let store: ReturnType<typeof stubStore>;

  function searchApp() {
    const app = express();
    app.use(createCatalogModule(store).router);
    return app;
  }

  function hit(resource: string) {
    return {
      resource,
      type: "http",
      x402Version: 2,
      accepts: [requirements],
      lastUpdated: "2026-08-13T00:00:00.000Z",
    };
  }

  beforeEach(() => {
    store = stubStore();
    store.search.mockResolvedValue([hit("https://api.example.com/weather")]);
  });

  it("answers with the search response shape, not the list shape", async () => {
    const res = await request(searchApp()).get("/discovery/search").query({ query: "weather" });

    expect(res.status).toBe(200);
    // The SDK names the array `resources` here and `items` on the list route.
    expect(res.body).toMatchObject({
      x402Version: 2,
      searchMethod: "hybrid",
      resources: [expect.objectContaining({ resource: "https://api.example.com/weather" })],
    });
    expect(res.body).not.toHaveProperty("items");
    expect(res.body).not.toHaveProperty("pagination");
  });

  it("requires a query", async () => {
    const res = await request(searchApp()).get("/discovery/search");

    expect(res.status).toBe(400);
    expect(store.search).not.toHaveBeenCalled();
  });

  it("defaults the limit to 10 and caps it at 20", async () => {
    await request(searchApp()).get("/discovery/search").query({ query: "weather" });
    expect(store.search).toHaveBeenCalledWith("weather", expect.anything(), 11);

    await request(searchApp()).get("/discovery/search").query({ query: "weather", limit: "500" });
    expect(store.search).toHaveBeenLastCalledWith("weather", expect.anything(), 21);
  });

  it("flags truncation when more matches existed than were asked for", async () => {
    store.search.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => hit(`https://api.example.com/r${index}`)),
    );

    const res = await request(searchApp()).get("/discovery/search").query({ query: "weather" });

    expect(res.body.resources).toHaveLength(10);
    expect(res.body.partialResults).toBe(true);
  });

  it("omits the truncation flag when everything fit", async () => {
    const res = await request(searchApp()).get("/discovery/search").query({ query: "weather" });

    expect(res.body.resources).toHaveLength(1);
    expect(res.body).not.toHaveProperty("partialResults");
  });

  it("passes the filters through to the store", async () => {
    await request(searchApp()).get("/discovery/search").query({
      query: "weather",
      type: "http",
      network: "stellar:testnet",
      asset: "CUSDC,XLM",
      tags: "weather,forecast",
      urlSubstring: "example.com",
      extensions: "bazaar",
    });

    expect(store.search).toHaveBeenCalledWith(
      "weather",
      expect.objectContaining({
        type: "http",
        network: "stellar:testnet",
        asset: ["CUSDC", "XLM"],
        tags: ["weather", "forecast"],
        urlSubstring: "example.com",
        extensions: "bazaar",
      }),
      11,
    );
  });

  it("rejects maxAmount unless exactly one asset is named", async () => {
    const res = await request(searchApp())
      .get("/discovery/search")
      .query({ query: "weather", maxAmount: "1000", asset: "CUSDC,XLM" });

    expect(res.status).toBe(400);
    expect(store.search).not.toHaveBeenCalled();
  });

  // Unchecked, the value reaches a Postgres ::numeric cast and the caller gets a
  // 500 for what is plainly a bad request.
  it("rejects a maxAmount that is not a whole number", async () => {
    const res = await request(searchApp())
      .get("/discovery/search")
      .query({ query: "weather", maxAmount: "abc", asset: "CUSDC" });

    expect(res.status).toBe(400);
    expect(store.search).not.toHaveBeenCalled();
  });

  it("serves the usage signals the store attached", async () => {
    const quality = {
      l30DaysTotalCalls: 7,
      l30DaysUniquePayers: 3,
      lastCalledAt: "2026-08-13T00:00:00.000Z",
    };
    store.search.mockResolvedValue([{ ...hit("https://api.example.com/weather"), quality }]);

    const res = await request(searchApp()).get("/discovery/search").query({ query: "weather" });

    expect(res.body.resources[0].quality).toEqual(quality);
  });

  it("leaves quality off a resource nobody has paid", async () => {
    const res = await request(searchApp()).get("/discovery/search").query({ query: "weather" });

    expect(res.body.resources[0]).not.toHaveProperty("quality");
  });

  describe("maxUsdPrice", () => {
    function priced(resource: string, asset: string, amount: string) {
      return {
        resource,
        type: "http",
        x402Version: 2,
        accepts: [{ ...requirements, asset, amount }],
        lastUpdated: "2026-08-13T00:00:00.000Z",
      };
    }

    // 1 USDC = $1, 1 XLM = $0.16, at 7 decimals.
    const feed = {
      usdPriceOf: (asset: string) => (asset === "CUSDC" ? 1 : asset === "XLM" ? 0.16 : null),
      atomicToUsd(asset: string, atomic: string) {
        const price = this.usdPriceOf(asset);
        return price === null ? null : (Number(atomic) / 1e7) * price;
      },
      hasAnyPrice: () => true,
    };

    function pricedApp() {
      const app = express();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.use(createCatalogModule(store, feed as any).router);
      return app;
    }

    // The ceiling itself is a SQL predicate, so what the route owes is handing it
    // to the store as a number. Its filtering behaviour is proven against real
    // SQL in catalog-store.test.ts.
    it("hands the ceiling to the store as a filter", async () => {
      await request(pricedApp())
        .get("/discovery/search")
        .query({ query: "weather", maxUsdPrice: "0.01" });

      expect(store.search).toHaveBeenCalledWith(
        "weather",
        expect.objectContaining({ maxUsdPrice: 0.01 }),
        11,
      );
    });

    it("rejects a maxUsdPrice that is not a positive number", async () => {
      for (const value of ["abc", "0", "-1"]) {
        const res = await request(pricedApp())
          .get("/discovery/search")
          .query({ query: "weather", maxUsdPrice: value });

        expect(res.status).toBe(400);
      }
      expect(store.search).not.toHaveBeenCalled();
    });

    it("says how many served results escaped the ceiling unpriced", async () => {
      store.search.mockResolvedValue([
        priced("https://cheap.example.com/a", "CUSDC", "10000"),
        priced("https://unmapped.example.com/b", "CMYSTERYASSET", "1"),
      ]);

      const res = await request(pricedApp())
        .get("/discovery/search")
        .query({ query: "weather", maxUsdPrice: "0.01" });

      expect(res.body.warnings).toEqual([expect.stringContaining("1")]);
    });

    it("says pricing is unavailable rather than blaming the assets", async () => {
      // A feed with no data at all is a different problem from an asset with no
      // mapping, and a caller cannot act on the two the same way.
      const emptyFeed = {
        usdPriceOf: () => null,
        atomicToUsd: () => null,
        hasAnyPrice: () => false,
      };
      const app = express();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.use(createCatalogModule(store, emptyFeed as any).router);
      store.search.mockResolvedValue([priced("https://a.example.com/x", "CUSDC", "10000")]);

      const res = await request(app)
        .get("/discovery/search")
        .query({ query: "weather", maxUsdPrice: "0.01" });

      expect(res.body.warnings).toEqual([expect.stringContaining("no usable USD rate")]);
      // An empty feed is equally the shape of a set key whose rates went stale,
      // so the warning must not pin it on a missing key.
      expect(res.body.warnings[0]).not.toContain("COINGECKO_API_KEY");
      expect(res.body.resources).toHaveLength(1);
    });

    it("counts only the results it actually returned as unpriced", async () => {
      store.search.mockResolvedValue(
        Array.from({ length: 11 }, (_, index) =>
          priced(`https://unmapped.example.com/r${index}`, "CMYSTERYASSET", "1"),
        ),
      );

      const res = await request(pricedApp())
        .get("/discovery/search")
        .query({ query: "weather", maxUsdPrice: "0.01" });

      // Ten served, so the warning must say ten and not the eleven fetched to
      // detect truncation.
      expect(res.body.resources).toHaveLength(10);
      expect(res.body.warnings[0]).toContain("10");
    });

    it("says nothing about pricing when no ceiling was asked for", async () => {
      store.search.mockResolvedValue([priced("https://unmapped.example.com/b", "CX", "1")]);

      const res = await request(pricedApp()).get("/discovery/search").query({ query: "weather" });

      expect(res.body).not.toHaveProperty("warnings");
    });
  });

  it("keeps the internal tool name out of the response", async () => {
    store.search.mockResolvedValue([
      { ...hit("https://mcp.example.com/rpc"), type: "mcp", toolName: "get_weather" },
    ]);

    const res = await request(searchApp()).get("/discovery/search").query({ query: "weather" });

    expect(res.body.resources[0]).not.toHaveProperty("toolName");
    expect(res.body.resources[0].resource).toBe("https://mcp.example.com/rpc");
  });
});
