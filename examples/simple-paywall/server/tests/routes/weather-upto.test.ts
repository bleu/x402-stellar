import { describe, it, expect, vi, beforeAll, beforeEach, type Mock } from "vitest";
import request from "supertest";
import type { Express } from "express";

// The paywall is stood down so the handler runs bare. That is also the only way
// to see the override it sets: the payment middleware reads the header and then
// strips it before the response leaves.
vi.mock("../../src/middleware/payment.js", () => ({
  createPaymentMiddlewares: () => [],
  createApiPaymentMiddlewares: () => [],
  createUptoApiPaymentMiddlewares: () => [],
}));

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
  return {
    logger: noopLogger,
    httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const FORECAST = {
  current: {
    temperature_2m: 62.3,
    relative_humidity_2m: 55,
    weather_code: 2,
    wind_speed_10m: 11.5,
  },
};

function geocode(name: string) {
  return {
    results: [{ name, latitude: 1, longitude: 2, country: "Somewhere", admin1: "Region" }],
  };
}

let app: Express;
let fetchSpy: Mock;

beforeAll(async () => {
  vi.stubEnv(
    "TESTNET_SERVER_STELLAR_ADDRESS",
    "GAJUGVETJ4NQIG64OQNLNL6KHXYQ46MFWBCXFIUMACK4MTOOTRYJN2KV",
  );
  vi.stubEnv("TESTNET_FACILITATOR_URL", "http://localhost:4022");
  const { createApp } = await import("../../src/app.js");
  app = createApp();
});

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

function mockUpstream(resolvedName: string | null) {
  fetchSpy.mockImplementation((url: string) => {
    if (new URL(url).hostname === "geocoding-api.open-meteo.com") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(resolvedName === null ? {} : geocode(resolvedName)),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(FORECAST) });
  });
}

describe("GET /weather-upto/:network", () => {
  it("charges the whole ceiling for a premium city", async () => {
    mockUpstream("Tokyo");

    const res = await request(app).get("/weather-upto/testnet?city=Tokyo");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.headers["settlement-overrides"])).toEqual({ amount: "30000" });
  });

  it("charges a third of the ceiling for any other city", async () => {
    mockUpstream("Curitiba");

    const res = await request(app).get("/weather-upto/testnet?city=Curitiba");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.headers["settlement-overrides"])).toEqual({ amount: "10000" });
  });

  it("charges nothing when the city cannot be resolved", async () => {
    mockUpstream(null);

    const res = await request(app).get("/weather-upto/testnet?city=Atlantis");

    expect(res.status).toBe(404);
    expect(res.headers["settlement-overrides"]).toBeUndefined();
  });
});
