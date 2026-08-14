import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const ROW = {
  resource: "http://localhost:3001/weather/testnet",
  type: "http",
  x402Version: 2,
  lastUpdated: new Date("2026-08-14T00:00:00.000Z").toISOString(),
  serviceName: "Stellar Weather",
  description: "Current weather and temperature for any city by name",
  tags: ["weather"],
  accepts: [
    {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "10000",
      payTo: "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO",
    },
  ],
  extensions: { bazaar: { info: { input: { type: "http", queryParams: { city: "Lisbon" } } } } },
};

/**
 * The x402 SDK's own Bazaar client against our discovery routes.
 *
 * Our /discovery/search accepts a superset of the spec's parameters, so the MCP
 * tool calls it directly rather than through this client. This test keeps the
 * other direction honest: the reference client, sending only spec parameters,
 * still gets a response that satisfies its own types.
 */
describe("SDK bazaar client against our discovery routes", () => {
  let server: Server;
  let baseUrl: string;
  const store = {
    list: vi.fn().mockResolvedValue({ items: [ROW], total: 1 }),
    search: vi.fn().mockResolvedValue([ROW]),
    quality: vi.fn().mockResolvedValue(new Map()),
  } as unknown as CatalogStore;

  beforeAll(async () => {
    const app = express();
    app.use(createCatalogModule(store).router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("lists resources into the shape the SDK expects", async () => {
    const client = withBazaar(new HTTPFacilitatorClient({ url: baseUrl }));

    const response = await client.extensions.bazaar.listResources({ type: "http", limit: 10 });

    expect(response.x402Version).toBe(2);
    expect(response.pagination).toEqual({ limit: 10, offset: 0, total: 1 });
    expect(response.items[0].resource).toBe(ROW.resource);
    // The declaration has to survive the round trip: it is how a client learns
    // which parameters an endpoint takes.
    expect(response.items[0].extensions).toEqual(ROW.extensions);
  });

  it("searches into the shape the SDK expects", async () => {
    const client = withBazaar(new HTTPFacilitatorClient({ url: baseUrl }));

    const response = await client.extensions.bazaar.search({
      query: "current weather for a city",
      limit: 5,
    });

    expect(response.x402Version).toBe(2);
    expect(response.resources[0].serviceName).toBe("Stellar Weather");
    expect(response.resources[0].accepts[0].asset).toBe(ROW.accepts[0].asset);
  });

  it("tolerates the cursor the SDK sends even though search is not paginated", async () => {
    const client = withBazaar(new HTTPFacilitatorClient({ url: baseUrl }));

    // The SDK documents that a facilitator may ignore limit and cursor. Ignoring
    // must mean ignoring, not rejecting the request.
    const response = await client.extensions.bazaar.search({
      query: "anything",
      cursor: "opaque-cursor",
    });

    expect(response.resources).toHaveLength(1);
  });
});
