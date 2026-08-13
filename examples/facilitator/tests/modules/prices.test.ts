import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  COINGECKO_IDS_BY_ASSET,
  PRICE_MAX_AGE_MS,
  PRICE_POLL_INTERVAL_MS,
  createPriceFeed,
  type PriceStore,
} from "../../src/modules/prices/index.js";

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

/** In-memory stand-in for the asset_usd_prices table. */
function stubPriceStore(): PriceStore & {
  rows: Map<string, { usdPrice: string; fetchedAt: Date }>;
} {
  const rows = new Map<string, { usdPrice: string; fetchedAt: Date }>();
  return {
    rows,
    async savePrices(prices) {
      for (const price of prices) {
        rows.set(price.asset, { usdPrice: price.usdPrice, fetchedAt: price.fetchedAt });
      }
    },
    async loadPrices() {
      return [...rows.entries()].map(([asset, row]) => ({ asset, ...row }));
    },
  };
}

const MAPPED_ASSET = [...COINGECKO_IDS_BY_ASSET.keys()][0];

describe("price feed", () => {
  let store: ReturnType<typeof stubPriceStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = stubPriceStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls a quarter-hourly, which stays inside CoinGecko's demo quota", () => {
    // 10,000 calls a month: 15 minutes is ~2,880 (29%), 5 minutes would be 86%.
    const callsPerMonth = (30 * 24 * 60 * 60 * 1000) / PRICE_POLL_INTERVAL_MS;
    expect(PRICE_POLL_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(callsPerMonth).toBeLessThan(10_000);
  });

  it("reports no price for an asset it has no mapping for", async () => {
    const feed = createPriceFeed({ store, apiKey: "key" });
    await feed.refresh();

    expect(feed.usdPriceOf("CUNKNOWNASSET")).toBeNull();
  });

  it("converts an atomic amount into usd for a mapped asset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ [COINGECKO_IDS_BY_ASSET.get(MAPPED_ASSET)!]: { usd: 2 } }),
      }),
    );

    const feed = createPriceFeed({ store, apiKey: "key" });
    await feed.refresh();

    expect(feed.usdPriceOf(MAPPED_ASSET)).toBe(2);
    // 7 decimals, the @x402/stellar default for a USD stablecoin.
    expect(feed.atomicToUsd(MAPPED_ASSET, "10000000")).toBe(2);
  });

  it("stops trusting a price once it is an hour stale", async () => {
    await store.savePrices([
      {
        asset: MAPPED_ASSET,
        coingeckoId: COINGECKO_IDS_BY_ASSET.get(MAPPED_ASSET)!,
        usdPrice: "2",
        fetchedAt: new Date(Date.now() - PRICE_MAX_AGE_MS - 1000),
      },
    ]);

    const feed = createPriceFeed({ store, apiKey: "key" });
    await feed.load();

    expect(feed.usdPriceOf(MAPPED_ASSET)).toBeNull();
  });

  it("keeps serving a price that is still fresh", async () => {
    await store.savePrices([
      {
        asset: MAPPED_ASSET,
        coingeckoId: COINGECKO_IDS_BY_ASSET.get(MAPPED_ASSET)!,
        usdPrice: "2",
        fetchedAt: new Date(Date.now() - 60_000),
      },
    ]);

    const feed = createPriceFeed({ store, apiKey: "key" });
    await feed.load();

    expect(feed.usdPriceOf(MAPPED_ASSET)).toBe(2);
  });

  it("does no polling without an api key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const feed = createPriceFeed({ store });
    await feed.refresh();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(feed.usdPriceOf(MAPPED_ASSET)).toBeNull();
  });

  it("keeps the last good price when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ [COINGECKO_IDS_BY_ASSET.get(MAPPED_ASSET)!]: { usd: 2 } }),
        })
        .mockRejectedValueOnce(new Error("coingecko down")),
    );

    const feed = createPriceFeed({ store, apiKey: "key" });
    await feed.refresh();
    await feed.refresh();

    expect(feed.usdPriceOf(MAPPED_ASSET)).toBe(2);
  });

  it("asks CoinGecko for every mapped asset in one call", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);

    const feed = createPriceFeed({ store, apiKey: "key" });
    await feed.refresh();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    for (const id of new Set(COINGECKO_IDS_BY_ASSET.values())) {
      expect(url).toContain(id);
    }
  });
});
