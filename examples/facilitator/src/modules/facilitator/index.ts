import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { Router } from "express";

import { Env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { validatePaymentPayload, validatePaymentRequirements } from "../../utils/validation.js";
import type { CatalogModule } from "../catalog/index.js";
import { createExactStellarScheme } from "./scheme.js";

export interface FacilitatorModule {
  router: Router;
}

/**
 * The facilitator module: x402 verify/settle/supported endpoints backed by
 * @x402/stellar's ExactStellarScheme. When a catalog module is provided, its
 * recorder runs as an after-settle side effect and never blocks settlement.
 */
export function createFacilitatorModule(catalog?: CatalogModule): FacilitatorModule {
  const scheme = createExactStellarScheme();

  const facilitator = new x402Facilitator()
    .onBeforeVerify(async (context) => {
      logger.debug({ context }, "Before verify");
    })
    .onAfterVerify(async (context) => {
      logger.debug({ context }, "After verify");
    })
    .onVerifyFailure(async (context) => {
      const verifyError =
        context.error instanceof Error
          ? context.error.message
          : String(context.error ?? "unknown_verify_failure");

      logger.warn({ context, verifyError }, "Verify failure");
    })
    .onBeforeSettle(async (context) => {
      logger.debug({ context }, "Before settle");
    })
    .onAfterSettle(async (context) => {
      logger.debug({ context }, "After settle");
      if (catalog) {
        await catalog.recordSettlement(context);
      }
    })
    .onSettleFailure(async (context) => {
      logger.warn({ context }, "Settle failure");
    });

  facilitator.register(Env.stellarNetwork, scheme);

  const router = Router();

  router.post("/verify", async (req, res): Promise<void> => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};

      const payloadError = validatePaymentPayload(paymentPayload);
      if (payloadError) {
        res.status(400).json({ error: payloadError });
        return;
      }

      const requirementsError = validatePaymentRequirements(paymentRequirements);
      if (requirementsError) {
        res.status(400).json({ error: requirementsError });
        return;
      }

      const response: VerifyResponse = await facilitator.verify(
        paymentPayload,
        paymentRequirements,
      );

      logger.info(
        {
          isValid: response.isValid,
          invalidReason: response.isValid ? undefined : response.invalidReason,
        },
        "Verify response",
      );

      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Verify error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  router.post("/settle", async (req, res): Promise<void> => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    try {
      const payloadError = validatePaymentPayload(paymentPayload);
      if (payloadError) {
        res.status(400).json({ error: payloadError });
        return;
      }

      const requirementsError = validatePaymentRequirements(paymentRequirements);
      if (requirementsError) {
        res.status(400).json({ error: requirementsError });
        return;
      }

      const response: SettleResponse = await facilitator.settle(
        paymentPayload as PaymentPayload,
        paymentRequirements as PaymentRequirements,
      );

      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Settle error");

      if (error instanceof Error && error.message.includes("Settlement aborted:")) {
        res.status(502).json({
          success: false,
          transaction: "",
          errorReason: "Settlement aborted",
          network: paymentRequirements?.network || "unknown",
        } satisfies SettleResponse);
        return;
      }

      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  router.get("/supported", async (_req, res) => {
    try {
      const response = facilitator.getSupported();
      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Supported error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return { router };
}
