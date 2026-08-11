import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import { createCatalogModule } from "../../src/modules/catalog/index.js";
import type { CatalogStore } from "../../src/modules/catalog/store.js";

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

function stubStore() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as CatalogStore & {
    upsert: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
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

function settleContext(overrides: Record<string, unknown> = {}) {
  return {
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://api.example.com/weather", description: "Weather" },
      accepted: requirements,
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
  });

  it("records the resource from a successful settlement", async () => {
    const catalog = createCatalogModule(store);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(settleContext() as any);

    expect(store.upsert).toHaveBeenCalledWith({
      resource: "https://api.example.com/weather",
      type: "http",
      x402Version: 2,
      accepts: [requirements],
      description: "Weather",
      mimeType: undefined,
    });
  });

  it("skips failed settlements", async () => {
    const catalog = createCatalogModule(store);
    await catalog.recordSettlement(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settleContext({ result: { success: false, transaction: "", network: "x" } }) as any,
    );

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("skips payloads without a resource url", async () => {
    const catalog = createCatalogModule(store);
    const context = settleContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (context.paymentPayload as any).resource;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await catalog.recordSettlement(context as any);

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("does not throw when the store fails", async () => {
    store.upsert.mockRejectedValue(new Error("db down"));
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
    expect(store.list).toHaveBeenCalledWith({
      type: undefined,
      payTo: undefined,
      scheme: "exact",
      network: "stellar:testnet",
      limit: 10,
      offset: 0,
    });
  });

  it("clamps bad pagination input to defaults", async () => {
    const app = express();
    app.use(createCatalogModule(store).router);

    const res = await request(app)
      .get("/discovery/resources")
      .query({ limit: "-5", offset: "nope" });

    expect(res.status).toBe(200);
    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 0 }),
    );
  });
});
