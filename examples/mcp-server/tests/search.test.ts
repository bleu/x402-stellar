import { describe, expect, it, vi } from "vitest";

import {
  NETWORK,
  TESTNET_USDC,
  XLM,
  connect,
  isError,
  resource,
  resultBody,
  searchResponse,
} from "./helpers.js";

describe("search_bazaar", () => {
  it("exposes both tools and nothing else", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["paid_request", "search_bazaar"]);
  });

  it("sends the query, the price ceiling and the extra filters", async () => {
    const fetchImpl = vi.fn(async () => searchResponse([]));
    const client = await connect({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });

    await client.callTool({
      name: "search_bazaar",
      arguments: {
        query: "does a thing",
        maxUsdPrice: 0.01,
        network: NETWORK,
        asset: [TESTNET_USDC],
        tags: ["thing", "other"],
        urlSubstring: "paid",
        limit: 3,
      },
    });

    const url = new URL(fetchImpl.mock.calls[0][0] as unknown as string);
    expect(url.pathname).toBe("/discovery/search");
    expect(url.searchParams.get("query")).toBe("does a thing");
    expect(url.searchParams.get("maxUsdPrice")).toBe("0.01");
    expect(url.searchParams.get("network")).toBe(NETWORK);
    expect(url.searchParams.get("asset")).toBe(TESTNET_USDC);
    expect(url.searchParams.get("tags")).toBe("thing,other");
    expect(url.searchParams.get("urlSubstring")).toBe("paid");
    expect(url.searchParams.get("limit")).toBe("3");
  });

  it("defaults to five results rather than the server's ten", async () => {
    const fetchImpl = vi.fn(async () => searchResponse([]));
    const client = await connect({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });

    await client.callTool({ name: "search_bazaar", arguments: { query: "anything" } });

    expect(new URL(fetchImpl.mock.calls[0][0] as unknown as string).searchParams.get("limit")).toBe(
      "5",
    );
  });

  it("renders the price in USD and keeps the atomic amount", async () => {
    const client = await connect({
      fetchImpl: (async () => searchResponse([resource()])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    const [first] = body.results as Record<string, unknown>[];

    expect(first.payable).toBe(true);
    expect(first.price).toMatchObject({ amountAtomic: "10000", usd: "0.001", decimals: 7 });
  });

  it("passes the declared parameter names through as the call shape", async () => {
    const client = await connect({
      fetchImpl: (async () => searchResponse([resource()])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    const [first] = body.results as Record<string, unknown>[];

    // This is the whole no-pre-baked-integration mechanism: the agent learns the
    // parameter name from the catalog rather than from us.
    expect(first.call).toEqual({ method: "GET", queryParams: { thing: "example" } });
  });

  it("keeps the quality signals so a repeat search shows the payment landed", async () => {
    const client = await connect({
      fetchImpl: (async () => searchResponse([resource()])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    const [first] = body.results as Record<string, unknown>[];

    expect(first.quality).toMatchObject({ l30DaysTotalCalls: 2, l30DaysUniquePayers: 1 });
  });

  it("flags an unpayable asset instead of hiding the result", async () => {
    const unpayable = resource({
      accepts: [
        { scheme: "exact", network: NETWORK, asset: XLM, amount: "5000000", payTo: "G..." },
      ],
    });
    const client = await connect({
      fetchImpl: (async () => searchResponse([unpayable])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    const [first] = body.results as Record<string, unknown>[];

    expect(first.payable).toBe(false);
    expect(first.price).toMatchObject({ asset: XLM });
    expect(first.price).not.toHaveProperty("usd");
    expect((body.notes as string[])[0]).toContain("cannot be paid by this wallet");
  });

  it("marks a scheme it cannot sign as unpayable, allowlisted asset or not", async () => {
    // Search and payment have to answer this identically. An upto-priced row in
    // an asset we hold is still something paid_request will refuse, so calling it
    // payable would send the agent at an endpoint it cannot buy.
    const uptoOnly = resource({
      accepts: [
        { scheme: "upto", network: NETWORK, asset: TESTNET_USDC, amount: "10000", payTo: "G..." },
      ],
    });
    const client = await connect({
      fetchImpl: (async () => searchResponse([uptoOnly])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    const [first] = body.results as Record<string, unknown>[];

    expect(first.payable).toBe(false);
    expect(first.price).toMatchObject({ scheme: "upto" });
    // No USD figure either: it is not a price this wallet can act on.
    expect(first.price).not.toHaveProperty("usd");
  });

  it("quotes the signable option when a resource offers two schemes", async () => {
    const mixed = resource({
      accepts: [
        { scheme: "upto", network: NETWORK, asset: TESTNET_USDC, amount: "1", payTo: "G..." },
        { scheme: "exact", network: NETWORK, asset: TESTNET_USDC, amount: "10000", payTo: "G..." },
      ],
    });
    const client = await connect({
      fetchImpl: (async () => searchResponse([mixed])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    const [first] = body.results as Record<string, unknown>[];

    expect(first.payable).toBe(true);
    expect(first.price).toMatchObject({ scheme: "exact", amountAtomic: "10000" });
  });

  it("quotes the cheapest payable option when several are offered", async () => {
    const multi = resource({
      accepts: [
        { scheme: "exact", network: NETWORK, asset: TESTNET_USDC, amount: "50000", payTo: "G..." },
        { scheme: "exact", network: NETWORK, asset: TESTNET_USDC, amount: "10000", payTo: "G..." },
      ],
    });
    const client = await connect({
      fetchImpl: (async () => searchResponse([multi])) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    expect((body.results as Record<string, unknown>[])[0].price).toMatchObject({
      amountAtomic: "10000",
    });
  });

  it("passes the facilitator's warnings and truncation flag through untouched", async () => {
    const warnings = ["maxUsdPrice was not applied: no usable USD rate is held"];
    const client = await connect({
      fetchImpl: (async () =>
        searchResponse([resource()], {
          warnings,
          partialResults: true,
        })) as unknown as typeof globalThis.fetch,
    });

    const body = resultBody(
      await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } }),
    );
    expect(body.warnings).toEqual(warnings);
    expect(body.partialResults).toBe(true);
    expect(body.searchMethod).toBe("hybrid");
  });

  it("reports an unreachable Bazaar as search_unavailable", async () => {
    const client = await connect({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    });

    const result = await client.callTool({ name: "search_bazaar", arguments: { query: "thing" } });
    const body = resultBody(result) as { error: { code: string; reason: string } };

    expect(isError(result)).toBe(true);
    expect(body.error.code).toBe("search_unavailable");
    expect(body.error.reason).toContain("ECONNREFUSED");
  });

  it("keeps the facilitator's own wording when it rejects a filter", async () => {
    const client = await connect({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "maxUsdPrice must be a positive number" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch,
    });

    const result = await client.callTool({
      name: "search_bazaar",
      arguments: { query: "thing", maxUsdPrice: 0.01 },
    });
    const body = resultBody(result) as { error: { code: string; reason: string } };

    expect(body.error.code).toBe("search_failed");
    expect(body.error.reason).toBe("maxUsdPrice must be a positive number");
  });
});
