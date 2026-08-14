import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { quotedRequirements } from "../../src/modules/catalog/record.js";

const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MERCHANT = "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO";

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "upto",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "30000",
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

function payload(accepted: PaymentRequirements): PaymentPayload {
  return { x402Version: 2, accepted, payload: {} };
}

describe("quotedRequirements", () => {
  it("keeps the ceiling as the price when the settle charged less", () => {
    // Core rewrites requirements.amount down to the charge before settling, so
    // recording that would advertise the last charge as the price and a
    // maxUsdPrice filter would compare against less than the call can cost.
    const quoted = quotedRequirements(payload(requirements()), requirements({ amount: "10000" }));

    expect(quoted.amount).toBe("30000");
  });

  it("leaves an exact payment alone, where the two are the same number", () => {
    const exact = requirements({ scheme: "exact", amount: "10000" });

    const quoted = quotedRequirements(payload(exact), exact);

    expect(quoted.amount).toBe("10000");
  });

  it("keeps the settled requirements for everything but the amount", () => {
    const quoted = quotedRequirements(
      payload(requirements({ payTo: "GHOSTILE" })),
      requirements({ amount: "10000" }),
    );

    expect(quoted).toMatchObject({ payTo: MERCHANT, asset: ASSET, scheme: "upto" });
  });

  it("ignores an accepted amount that is not atomic units", () => {
    const quoted = quotedRequirements(
      payload(requirements({ amount: "$0.003" })),
      requirements({ amount: "10000" }),
    );

    expect(quoted.amount).toBe("10000");
  });

  it("never lowers the price below what was actually charged", () => {
    const quoted = quotedRequirements(payload(requirements({ amount: "1" })), requirements());

    expect(quoted.amount).toBe("30000");
  });
});
