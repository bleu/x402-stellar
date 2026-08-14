import { logger } from "../../utils/logger.js";

/**
 * Contract-to-CoinGecko mapping, maintained by hand.
 *
 * CoinGecko indexes Stellar (`/asset_platforms` lists `stellar`) but only
 * mainnet contracts: the pubnet USDC SAC resolves to `usd-coin`, while testnet
 * SAC addresses are not indexed at all. A static map is therefore unavoidable
 * for a testnet deployment.
 */
export const COINGECKO_IDS_BY_ASSET = new Map<string, string>([
  // USDC SAC, pubnet and testnet.
  ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", "usd-coin"],
  ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "usd-coin"],
  ["XLM", "stellar"],
  ["native", "stellar"],
]);

/**
 * Assets taken to be worth a dollar without asking anyone.
 *
 * Both mapped USDC contracts hold a USD peg by definition, and the testnet one
 * is not indexed by CoinGecko at all, so a live quote would never arrive for the
 * asset the demo actually charges in. Assuming the peg is what lets maxUsdPrice
 * filter with no API key and no network. Non-stable assets like XLM still need a
 * real rate and stay unpriced until one arrives.
 */
export const ASSUMED_USD_PRICES = new Map<string, number>([
  ["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", 1],
  ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", 1],
]);

/**
 * Atomic units per whole token. `PaymentRequirements` carries no decimals
 * field and @x402/stellar defaults to 7, so every USD conversion rests on a
 * documented "7-decimal token" assumption for mapped assets.
 */
export const ASSET_DECIMALS = 7;

/**
 * 15 minutes: about 2,880 calls a month against CoinGecko's 10,000-call demo
 * quota (29%). A 5-minute poll would be ~8,640 (86%).
 */
export const PRICE_POLL_INTERVAL_MS = 15 * 60 * 1000;

/** Four missed polls. Past this a price is treated as unknown, not as stale. */
export const PRICE_MAX_AGE_MS = 60 * 60 * 1000;

export interface AssetPrice {
  asset: string;
  coingeckoId: string;
  usdPrice: string;
  fetchedAt: Date;
}

/** Persistence for prices, so a restart does not start with an empty feed. */
export interface PriceStore {
  savePrices(prices: AssetPrice[]): Promise<void>;
  loadPrices(): Promise<{ asset: string; usdPrice: string; fetchedAt: Date }[]>;
}

export interface PriceFeed {
  /** Reads the last persisted prices into memory. */
  load(): Promise<void>;
  /** Fetches current prices and persists them. Never throws. */
  refresh(): Promise<void>;
  /** Starts the poll loop. */
  start(): void;
  stop(): void;
  /** USD per whole token, or null when unmapped or too stale to trust. */
  usdPriceOf(asset: string): number | null;
  /** Converts atomic units to USD, or null when the price is unavailable. */
  atomicToUsd(asset: string, atomicAmount: string): number | null;
  /** Whether any price is currently fresh enough to use. */
  hasAnyPrice(): boolean;
}

interface PriceFeedOptions {
  store: PriceStore;
  /** Without a key the loop stays off and every price reads as unknown. */
  apiKey?: string;
}

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

export function createPriceFeed({ store, apiKey }: PriceFeedOptions): PriceFeed {
  const prices = new Map<string, { usdPrice: number; fetchedAt: number }>();
  let timer: NodeJS.Timeout | undefined;

  function remember(asset: string, usdPrice: number, fetchedAt: Date): void {
    if (!Number.isFinite(usdPrice) || usdPrice <= 0) return;
    prices.set(asset, { usdPrice, fetchedAt: fetchedAt.getTime() });
  }

  return {
    async load() {
      const rows = await store.loadPrices();
      for (const row of rows) remember(row.asset, Number(row.usdPrice), row.fetchedAt);
    },

    async refresh() {
      try {
        // Written every tick, not just at startup, so the assumed rates stay
        // inside PRICE_MAX_AGE_MS and keep filtering on a keyless deployment.
        const assumedAt = new Date();
        const assumed: AssetPrice[] = [...ASSUMED_USD_PRICES].map(([asset, usd]) => ({
          asset,
          coingeckoId: COINGECKO_IDS_BY_ASSET.get(asset) ?? "assumed-usd-peg",
          usdPrice: String(usd),
          fetchedAt: assumedAt,
        }));
        for (const price of assumed) remember(price.asset, Number(price.usdPrice), assumedAt);
        await store.savePrices(assumed);

        if (!apiKey) return;

        // Only the assets whose price is not assumed, so a quote cannot move a
        // pegged stablecoin and make demo prices wander.
        const quoted = [...COINGECKO_IDS_BY_ASSET].filter(
          ([asset]) => !ASSUMED_USD_PRICES.has(asset),
        );
        const ids = [...new Set(quoted.map(([, coingeckoId]) => coingeckoId))];
        if (ids.length === 0) return;

        // One batched call per tick rather than one per asset.
        const url = `${COINGECKO_URL}?ids=${ids.join(",")}&vs_currencies=usd`;
        const response = await fetch(url, { headers: { "x-cg-demo-api-key": apiKey } });
        if (!response.ok) throw new Error(`CoinGecko responded ${response.status}`);

        const body = (await response.json()) as Record<string, { usd?: number }>;
        const fetchedAt = new Date();
        const fetched: AssetPrice[] = [];

        for (const [asset, coingeckoId] of quoted) {
          const usd = body[coingeckoId]?.usd;
          if (typeof usd !== "number") continue;
          remember(asset, usd, fetchedAt);
          fetched.push({ asset, coingeckoId, usdPrice: String(usd), fetchedAt });
        }

        if (fetched.length > 0) await store.savePrices(fetched);
      } catch (error) {
        // The last good price stays in memory until it ages out, which is
        // better than dropping every price filter on one bad tick.
        logger.error({ err: error }, "Price refresh failed");
      }
    },

    start() {
      // Armed with or without a key: even keyless, each tick restamps the
      // assumed stablecoin rates so they never age out of use.
      if (!apiKey) {
        logger.info("No COINGECKO_API_KEY; maxUsdPrice judges assumed stablecoin rates only");
      }
      timer = setInterval(() => void this.refresh(), PRICE_POLL_INTERVAL_MS);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    usdPriceOf(asset) {
      const entry = prices.get(asset);
      if (!entry) return null;
      if (Date.now() - entry.fetchedAt > PRICE_MAX_AGE_MS) return null;
      return entry.usdPrice;
    },

    hasAnyPrice() {
      const cutoff = Date.now() - PRICE_MAX_AGE_MS;
      return [...prices.values()].some((entry) => entry.fetchedAt >= cutoff);
    },

    atomicToUsd(asset, atomicAmount) {
      const usdPrice = this.usdPriceOf(asset);
      if (usdPrice === null) return null;
      const atomic = Number(atomicAmount);
      if (!Number.isFinite(atomic)) return null;
      return (atomic / 10 ** ASSET_DECIMALS) * usdPrice;
    },
  };
}
