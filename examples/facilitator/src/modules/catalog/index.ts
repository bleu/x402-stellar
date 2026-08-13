import type { FacilitatorSettleResultContext } from "@x402/core/facilitator";
import { extractDiscoveryInfo } from "@x402/extensions/bazaar";
import { Router, type Request } from "express";

import { logger } from "../../utils/logger.js";
import { CatalogStore, type CatalogFilters, type CatalogResource } from "./store.js";
import { toCatalogRecord, toResourceKey } from "./record.js";

export interface CatalogModule {
  router: Router;
  /** After-settle hook: records the paid resource. Never throws. */
  recordSettlement(context: FacilitatorSettleResultContext): Promise<void>;
  close(): Promise<void>;
}

/** The slice of the price feed the catalog needs. */
export interface UsdPrices {
  usdPriceOf(asset: string): number | null;
  atomicToUsd(asset: string, atomicAmount: string): number | null;
  /**
   * Whether any usable price is held at all. A feed with nothing in it is a
   * different problem from an asset with no mapping, and the two warrant
   * different warnings.
   */
  hasAnyPrice(): boolean;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Search returns a ranked head, not pages, so its limits are much smaller. */
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function parseString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function parseList(raw: unknown): string[] | undefined {
  const value = parseString(raw);
  if (!value) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

/** The filters both discovery routes accept, read from the query string. */
function parseFilters(query: Request["query"]): CatalogFilters {
  return {
    type: parseString(query.type),
    payTo: parseString(query.payTo),
    scheme: parseString(query.scheme),
    network: parseString(query.network),
    extensions: parseString(query.extensions),
    asset: parseList(query.asset),
    maxAmount: parseString(query.maxAmount),
    tags: parseList(query.tags),
    urlSubstring: parseString(query.urlSubstring),
  };
}

/**
 * maxAmount is denominated in one asset's atomic units, so it only means
 * something next to exactly one asset. Rejected rather than silently dropped.
 */
function invalidFilterReason(filters: CatalogFilters): string | undefined {
  if (filters.maxAmount !== undefined && filters.asset?.length !== 1) {
    return "maxAmount requires exactly one asset";
  }
  return undefined;
}

/** The cheapest of a resource's observed options in USD, if any can be priced. */
function cheapestUsd(resource: CatalogResource, feed: UsdPrices): number | null {
  const prices = resource.accepts
    .map((option) =>
      typeof option.asset === "string" && typeof option.amount === "string"
        ? feed.atomicToUsd(option.asset, option.amount)
        : null,
    )
    .filter((usd): usd is number => usd !== null);

  return prices.length > 0 ? Math.min(...prices) : null;
}

/**
 * Applies a USD ceiling, keeping resources whose assets have no rate.
 *
 * Dropping the unpriceable ones would quietly hide resources for a reason the
 * caller never asked about, so they stay and the response says how many escaped
 * the filter.
 */
function applyMaxUsdPrice(
  resources: CatalogResource[],
  maxUsdPrice: number,
  feed: UsdPrices,
): CatalogResource[] {
  return resources.filter((resource) => {
    const usd = cheapestUsd(resource, feed);
    return usd === null || usd <= maxUsdPrice;
  });
}

/**
 * The catalog module: persists resources seen in successful settlements and
 * serves them at GET /discovery/resources (x402 Bazaar list shape). Phase 2
 * adds Bazaar extension validation on top of the same store.
 */
export function createCatalogModule(store: CatalogStore, prices?: UsdPrices): CatalogModule {
  const router = Router();

  router.get("/discovery/resources", async (req, res) => {
    try {
      const filters = parseFilters(req.query);
      const reason = invalidFilterReason(filters);
      if (reason) {
        res.status(400).json({ error: reason });
        return;
      }

      const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      const offset = parsePositiveInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const { items, total } = await store.list({ ...filters, limit, offset });

      res.json({ x402Version: 2, items, pagination: { limit, offset, total } });
    } catch (error) {
      logger.error({ err: error }, "Discovery resources error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  router.get("/discovery/search", async (req, res) => {
    try {
      const query = parseString(req.query.query);
      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const filters = parseFilters(req.query);
      const reason = invalidFilterReason(filters);
      if (reason) {
        res.status(400).json({ error: reason });
        return;
      }

      const maxUsdPrice = parseString(req.query.maxUsdPrice);
      const limit = parsePositiveInt(req.query.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      // One extra row tells truncation from an exact fit without a second query.
      let ranked = await store.search(query, filters, limit + 1);

      const warnings: string[] = [];
      let priceable: UsdPrices | undefined;

      if (maxUsdPrice !== undefined) {
        const ceiling = Number(maxUsdPrice);
        if (!Number.isFinite(ceiling) || ceiling <= 0) {
          res.status(400).json({ error: "maxUsdPrice must be a positive number" });
          return;
        }
        if (!prices || !prices.hasAnyPrice()) {
          warnings.push(
            "maxUsdPrice was not applied: no USD price feed is available (set COINGECKO_API_KEY)",
          );
        } else {
          priceable = prices;
          ranked = applyMaxUsdPrice(ranked, ceiling, prices);
        }
      }

      const partialResults = ranked.length > limit;
      // `toolName` is row identity, not part of the served DiscoveryResource; a
      // client reads the tool name from `extensions.bazaar`.
      const resources = ranked.slice(0, limit).map((ranked) => {
        const resource = { ...ranked };
        delete resource.toolName;
        return resource;
      });

      // Counted over what is actually served, so the number matches the list the
      // caller can see rather than the extra row fetched to spot truncation.
      if (priceable) {
        const unpriced = resources.filter((r) => cheapestUsd(r, priceable!) === null).length;
        if (unpriced > 0) {
          warnings.push(
            `${unpriced} result(s) were kept without checking maxUsdPrice because their asset has no USD rate`,
          );
        }
      }

      res.json({
        x402Version: 2,
        resources,
        searchMethod: "hybrid",
        ...(partialResults ? { partialResults: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      logger.error({ err: error }, "Discovery search error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return {
    router,

    async recordSettlement(context) {
      try {
        if (!context.result.success) return;

        // Owns route-template validation, service-metadata soft-drops, JSON-Schema
        // validation of `info`, and canonicalising the resource url. Returns null
        // when the payer's payload carries no bazaar extension, which is the only
        // signal we get that a resource wants to be discoverable.
        const discovered = extractDiscoveryInfo(context.paymentPayload, context.requirements);
        if (!discovered) return;

        await store.upsertWithSettlement(toCatalogRecord(discovered, context.requirements), {
          ...toResourceKey(discovered),
          asset: context.requirements.asset,
          payer: context.result.payer,
        });
      } catch (error) {
        // Cataloging is a side effect; a store failure must not fail settlement.
        logger.error({ err: error }, "Catalog record failed");
      }
    },

    async close() {
      await store.close();
    },
  };
}
