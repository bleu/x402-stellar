import type { FacilitatorSettleResultContext } from "@x402/core/facilitator";
import { Router } from "express";

import { logger } from "../../utils/logger.js";
import { CatalogStore } from "./store.js";

export interface CatalogModule {
  router: Router;
  /** After-settle hook: records the paid resource. Never throws. */
  recordSettlement(context: FacilitatorSettleResultContext): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

/**
 * The catalog module: persists resources seen in successful settlements and
 * serves them at GET /discovery/resources (x402 Bazaar list shape). Phase 2
 * adds Bazaar extension validation on top of the same store.
 */
export function createCatalogModule(store: CatalogStore): CatalogModule {
  const router = Router();

  router.get("/discovery/resources", async (req, res) => {
    try {
      const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      const offset = parsePositiveInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const { items, total } = await store.list({
        type: typeof req.query.type === "string" ? req.query.type : undefined,
        payTo: typeof req.query.payTo === "string" ? req.query.payTo : undefined,
        scheme: typeof req.query.scheme === "string" ? req.query.scheme : undefined,
        network: typeof req.query.network === "string" ? req.query.network : undefined,
        limit,
        offset,
      });

      res.json({ x402Version: 2, items, pagination: { limit, offset, total } });
    } catch (error) {
      logger.error({ err: error }, "Discovery resources error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return {
    router,

    async recordSettlement(context) {
      try {
        if (!context.result.success) return;
        const url = context.paymentPayload.resource?.url;
        if (!url) return;

        await store.upsert({
          resource: url,
          type: "http",
          x402Version: context.paymentPayload.x402Version,
          accepts: [context.requirements as unknown as Record<string, unknown>],
          description: context.paymentPayload.resource?.description,
          mimeType: context.paymentPayload.resource?.mimeType,
          serviceName: context.paymentPayload.resource?.serviceName,
          tags: context.paymentPayload.resource?.tags,
          iconUrl: context.paymentPayload.resource?.iconUrl,
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
