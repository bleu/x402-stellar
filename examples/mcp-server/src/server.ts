import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AssetAllowlist } from "./assets.js";
import { searchBazaar, type SearchParams } from "./bazaar.js";
import { toErrorBody } from "./errors.js";
import { logger } from "./logger.js";
import type { PaidRequestInput, PaidRequestOutput } from "./payer.js";

/**
 * Tool descriptions document parameters and the payment protocol, and never
 * name a service, a domain, or a subject area. Anything more would be telling
 * the agent where to go, which is the one thing this demo claims not to do.
 * A test asserts the seed corpus's service names appear nowhere in them.
 */
function searchDescription(assets: AssetAllowlist): string {
  return [
    "Search the x402 Bazaar for paid API endpoints that can serve a request.",
    "The Bazaar is a catalog of endpoints that charge per call. Each result carries its price,",
    "the parameters it accepts and an example call, so an endpoint can be used with no prior integration.",
    "Set maxUsdPrice, a number of US dollars, when the user states a spending limit.",
    `Results marked payable: false are priced in an asset this wallet cannot pay (it holds ${assets.describe()});`,
    "they are still listed so the reason a request cannot be served is visible.",
  ].join(" ");
}

function payDescription(): string {
  return [
    "Fetch an HTTP endpoint, paying automatically if it answers 402 Payment Required.",
    "Pass the resource URL exactly as search_bazaar returned it, and build query or body from that result's call object.",
    "The payment is signed locally and bounded by a per-call limit and a session budget;",
    "a payment that would break either limit is refused with a machine-readable code instead of being made.",
    "Returns the endpoint's response, the settlement transaction, and what is left of the budget.",
  ].join(" ");
}

export interface ServerDeps {
  facilitatorUrl: string;
  assets: AssetAllowlist;
  fetchImpl: typeof globalThis.fetch;
  pay(input: PaidRequestInput): Promise<PaidRequestOutput>;
}

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The MCP surface: two free tools, one that reads the catalog and one that pays.
 * Dependencies are injected so tests can drive the real server over an in-memory
 * transport with no key, no network and no chain.
 */
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "x402-stellar-bazaar", version: "1.0.0" });

  server.registerTool(
    "search_bazaar",
    {
      title: "Search the x402 Bazaar",
      description: searchDescription(deps.assets),
      inputSchema: {
        query: z.string().min(1).describe("What the endpoint should do, in natural language"),
        maxUsdPrice: z
          .number()
          .positive()
          .optional()
          .describe("Highest price per call, in US dollars"),
        network: z.string().optional().describe("CAIP-2 network id, e.g. stellar:testnet"),
        asset: z
          .array(z.string())
          .optional()
          .describe("Only endpoints priced in one of these asset contracts"),
        tags: z.array(z.string()).optional().describe("Only endpoints carrying one of these tags"),
        urlSubstring: z.string().optional().describe("Only endpoints whose URL contains this text"),
        limit: z.number().int().min(1).max(20).optional().describe("How many results, default 5"),
      },
    },
    async (args) => {
      try {
        const params: SearchParams = { ...args, limit: args.limit ?? 5 };
        const result = await searchBazaar(
          { facilitatorUrl: deps.facilitatorUrl, assets: deps.assets, fetchImpl: deps.fetchImpl },
          params,
        );
        return jsonResult(result);
      } catch (error) {
        logger.warn({ err: error }, "search_bazaar failed");
        return jsonResult(toErrorBody(error), true);
      }
    },
  );

  server.registerTool(
    "paid_request",
    {
      title: "Call a paid endpoint",
      description: payDescription(),
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL, exactly as the Bazaar returned it"),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
          .optional()
          .describe("HTTP method, default GET"),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query-string parameters"),
        body: z.unknown().optional().describe("Request body, sent as JSON unless already a string"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Extra request headers. Payment headers cannot be set here"),
      },
    },
    async (args) => {
      try {
        const result = await deps.pay(args as PaidRequestInput);
        return jsonResult(result);
      } catch (error) {
        logger.warn({ err: error }, "paid_request failed");
        return jsonResult(toErrorBody(error), true);
      }
    },
  );

  return server;
}

export { searchDescription, payDescription };
