import { describe, it, expect, vi } from "vitest";

import { buildApiRouteConfig, WEATHER_PRICE } from "../../src/middleware/payment.js";

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

describe("weather route config", () => {
  it("declares a bazaar discovery extension so the facilitator can catalog it", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildApiRouteConfig(netConfig as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bazaar = (config.extensions as any)?.bazaar;
    expect(bazaar).toBeDefined();
    expect(bazaar.info.input.type).toBe("http");
    expect(bazaar.info.input.queryParams).toHaveProperty("city");
  });

  it("carries the service metadata that discovery search ranks on", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildApiRouteConfig(netConfig as any);

    expect(config.serviceName).toBeTruthy();
    expect(config.description).toBeTruthy();
    expect(config.tags).toContain("weather");
  });

  it("keeps the service name and tags inside the bazaar soft-drop limits", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildApiRouteConfig(netConfig as any);

    // sanitizeResourceServiceMetadata drops a longer name and trims past 5 tags.
    expect(config.serviceName!.length).toBeLessThanOrEqual(32);
    expect(config.tags!.length).toBeLessThanOrEqual(5);
  });

  it("prices the route under a cent so a one-cent ceiling is not a tie", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildApiRouteConfig(netConfig as any);
    const accepts = Array.isArray(config.accepts) ? config.accepts : [config.accepts];

    expect(WEATHER_PRICE).toBe("0.001");
    expect(Number(WEATHER_PRICE)).toBeLessThan(0.01);
    expect(accepts[0].price).toBe(WEATHER_PRICE);
  });

  it("shows the response shape so output keys are searchable", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = buildApiRouteConfig(netConfig as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bazaar = (config.extensions as any)?.bazaar;

    expect(bazaar.info.output.example).toBeDefined();
  });
});
