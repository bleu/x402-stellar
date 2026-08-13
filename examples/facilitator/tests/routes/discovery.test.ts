import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import type express from "express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Captures the after-settle hook that createFacilitatorModule registers, so
// the facilitator -> catalog wiring can be exercised without a real scheme.
const mockState = vi.hoisted(() => ({
  afterSettle: undefined as ((context: unknown) => Promise<void>) | undefined,
}));

vi.mock("@x402/core/facilitator", () => ({
  x402Facilitator: vi.fn().mockImplementation(function () {
    const instance: Record<string, unknown> = {};
    Object.assign(instance, {
      onBeforeVerify: () => instance,
      onAfterVerify: () => instance,
      onVerifyFailure: () => instance,
      onBeforeSettle: () => instance,
      onAfterSettle: (hook: (context: unknown) => Promise<void>) => {
        mockState.afterSettle = hook;
        return instance;
      },
      onSettleFailure: () => instance,
      register: vi.fn(),
      verify: vi.fn().mockResolvedValue({ isValid: true }),
      settle: vi.fn(),
      getSupported: vi.fn().mockReturnValue({ kinds: [] }),
    });
    return instance;
  }),
}));

vi.mock("@x402/stellar", () => ({
  createEd25519Signer: vi.fn().mockReturnValue({
    address: "GMOCKADDRESS",
    sign: vi.fn(),
  }),
}));

vi.mock("@x402/stellar/exact/facilitator", () => ({
  ExactStellarScheme: vi.fn(),
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

const TEST_API_KEY = "test-secret-key-12345";

function stubStore() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertWithSettlement: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let app: express.Express;
let store: ReturnType<typeof stubStore>;

beforeAll(async () => {
  process.env.FACILITATOR_API_KEY = TEST_API_KEY;
  const { createApp } = await import("../../src/app.js");
  const { createCatalogModule } = await import("../../src/modules/catalog/index.js");
  const { CatalogStore } = await import("../../src/modules/catalog/store.js");
  store = stubStore();
  app = createApp(createCatalogModule(store as unknown as InstanceType<typeof CatalogStore>));
  delete process.env.FACILITATOR_API_KEY;
});

describe("catalog wiring through createApp", () => {
  it("serves /discovery/resources without an API key on a keyed deployment", async () => {
    const res = await request(app).get("/discovery/resources");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("pagination");
  });

  it("still requires the API key on /verify", async () => {
    const res = await request(app).post("/verify").send({});
    expect(res.status).toBe(401);
  });

  it("records a successful settlement in the catalog via the after-settle hook", async () => {
    expect(mockState.afterSettle).toBeDefined();
    const { bazaar } = declareDiscoveryExtension({
      input: { city: "San Francisco" },
      inputSchema: { properties: { city: { type: "string" } } },
    });
    await mockState.afterSettle!({
      paymentPayload: {
        x402Version: 2,
        resource: { url: "https://api.example.com/weather" },
        accepted: {},
        // Only bazaar-declaring resources are cataloged, so the wiring can
        // only be observed through a payload that carries the extension.
        extensions: {
          bazaar: {
            ...bazaar,
            info: { ...bazaar.info, input: { ...bazaar.info.input, method: "GET" } },
          },
        },
        payload: {},
      },
      requirements: { scheme: "exact", network: "stellar:testnet" },
      result: { success: true, transaction: "abc", network: "stellar:testnet" },
    });

    expect(store.upsertWithSettlement).toHaveBeenCalledTimes(1);
    expect(store.upsertWithSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "https://api.example.com/weather" }),
      expect.anything(),
    );
  });
});
