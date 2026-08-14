import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PaymentAbility, SIGNABLE_SCHEMES } from "../src/ability.js";
import { AssetAllowlist, DEFAULT_PAYABLE_ASSETS } from "../src/assets.js";
import { createMcpServer, type ServerDeps } from "../src/server.js";

export const TESTNET_USDC = DEFAULT_PAYABLE_ASSETS[0].asset;
export const NETWORK = DEFAULT_PAYABLE_ASSETS[0].network;
export const XLM = "CXLMUNMAPPEDASSETCONTRACTADDRESSFORTESTINGONLY000000000";

export const assets = new AssetAllowlist(DEFAULT_PAYABLE_ASSETS);
export const ability = new PaymentAbility(assets, SIGNABLE_SCHEMES);

/** Drives the real server over an in-memory transport, as a client would. */
export async function connect(deps: Partial<ServerDeps> = {}): Promise<Client> {
  const server = createMcpServer({
    facilitatorUrl: "http://facilitator.test",
    ability,
    fetchImpl: (async () => {
      throw new Error("fetch not stubbed");
    }) as unknown as typeof globalThis.fetch,
    pay: async () => {
      throw new Error("pay not stubbed");
    },
    ...deps,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** The text content of a tool result, parsed back into an object. */
export function resultBody(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** A search response in the shape our facilitator serves. */
export function searchResponse(
  resources: Record<string, unknown>[],
  extras: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ x402Version: 2, resources, searchMethod: "hybrid", ...extras }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** One catalog row, with the bazaar extension a resource server declares. */
export function resource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource: "http://localhost:3001/paid/thing",
    type: "http",
    x402Version: 2,
    lastUpdated: "2026-08-14T00:00:00.000Z",
    serviceName: "Some Service",
    description: "Does a thing for a fee",
    tags: ["thing"],
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: TESTNET_USDC,
        amount: "10000",
        payTo: "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO",
        maxTimeoutSeconds: 300,
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { thing: "example" } },
          output: { example: { answer: 42 } },
        },
      },
    },
    quality: { l30DaysTotalCalls: 2, l30DaysUniquePayers: 1, lastCalledAt: "2026-08-13T00:00:00Z" },
    ...overrides,
  };
}
