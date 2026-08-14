import { describe, it, expect, vi } from "vitest";

import { buildUptoApiRouteConfig, WEATHER_UPTO_CAP } from "../../src/middleware/payment.js";
import {
  uptoSettlementAmount,
  UPTO_PREMIUM_ATOMIC,
  UPTO_STANDARD_ATOMIC,
} from "../../src/routes/uptoPricing.js";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const netConfig = {
  network: "stellar:testnet" as const,
  serverStellarAddress: "GMERCHANT",
  facilitatorUrl: "http://localhost:4022",
  stellarRpcUrl: "https://soroban-testnet.stellar.org",
  facilitatorApiKey: undefined,
};

/** Stellar assets carry seven decimals. */
function toAtomic(price: string): bigint {
  return BigInt(Math.round(Number(price) * 10 ** 7));
}

describe("weather-upto route config", () => {
  it("offers a ceiling and nothing else, so the agent has to sign an upto", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildUptoApiRouteConfig(netConfig as any);
    const accepts = Array.isArray(config.accepts) ? config.accepts : [config.accepts];

    expect(accepts).toHaveLength(1);
    expect(accepts[0].scheme).toBe("upto");
    expect(accepts[0].price).toBe(WEATHER_UPTO_CAP);
  });

  it("declares a bazaar discovery extension so the facilitator can catalog it", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildUptoApiRouteConfig(netConfig as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bazaar = (config.extensions as any)?.bazaar;
    expect(bazaar).toBeDefined();
    expect(bazaar.info.input.queryParams).toHaveProperty("city");
  });

  it("declares an example city that settles under the ceiling", () => {
    // An agent calls the declared example first. A premium city there would
    // always take the whole ceiling, and the partial settle -- the only reason
    // this route exists -- would never be visible.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildUptoApiRouteConfig(netConfig as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const example = (config.extensions as any).bazaar.info.input.queryParams.city as string;

    expect(uptoSettlementAmount(example)).toBe(UPTO_STANDARD_ATOMIC);
  });

  it("never charges more than the ceiling it quoted", () => {
    const cap = toAtomic(WEATHER_UPTO_CAP);

    expect(BigInt(UPTO_PREMIUM_ATOMIC)).toBeLessThanOrEqual(cap);
    expect(BigInt(UPTO_STANDARD_ATOMIC)).toBeLessThan(cap);
  });

  it("charges the same city the same amount every time", () => {
    expect(uptoSettlementAmount("Tokyo")).toBe(uptoSettlementAmount("  tokyo "));
    expect(uptoSettlementAmount("Tokyo")).toBe(UPTO_PREMIUM_ATOMIC);
    expect(uptoSettlementAmount("Curitiba")).toBe(UPTO_STANDARD_ATOMIC);
  });
});
