import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, it, vi } from "vitest";

import { SessionBudget } from "../src/budget.js";
import { BUDGET_DECIMALS, toAtomic } from "../src/assets.js";
import { createPayer } from "../src/payer.js";
import { NETWORK, TESTNET_USDC, XLM, ability, connect, isError, resultBody } from "./helpers.js";

const PAYER = "GCRXEB4BNIMRSNUZNAXQS2S7ZV236ZZEAENFYUOZLLTIQ3QMTNQZQ55Y";
const RESOURCE = "http://localhost:3001/paid/thing";

/** Signs nothing: it stands in for the Stellar scheme so tests need no key. */
function fakeScheme(): SchemeNetworkClient {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version) {
      return { x402Version, payload: { transaction: "AAAA-fake-xdr" } };
    },
  };
}

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: TESTNET_USDC,
    amount: "10000",
    payTo: "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO",
    maxTimeoutSeconds: 300,
    ...overrides,
  } as PaymentRequirements;
}

/**
 * A 402 as the protocol defines it for v2: the requirements ride in the base64
 * PAYMENT-REQUIRED header, and the body is only a courtesy. The client ignores a
 * v2 body entirely, so a fixture without the header never reaches the signer.
 */
function paymentRequired(options: PaymentRequirements[] = [requirements()]): Response {
  const body = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: RESOURCE, description: "Does a thing for a fee" },
    accepts: options,
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body),
    },
  });
}

function settled(transaction = "abc123", success = true): Response {
  return new Response(JSON.stringify({ answer: 42 }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success,
        transaction,
        network: NETWORK,
        payer: PAYER,
      }),
    },
  });
}

interface Harness {
  pay: ReturnType<typeof createPayer>;
  budget: SessionBudget;
  fetchImpl: ReturnType<typeof vi.fn>;
}

function harness(responses: Response[], limits = { perCall: "0.01", session: "0.05" }): Harness {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("no response queued");
    return next;
  });

  const budget = new SessionBudget(
    toAtomic(limits.perCall, BUDGET_DECIMALS),
    toAtomic(limits.session, BUDGET_DECIMALS),
  );

  const pay = createPayer({
    network: NETWORK as `${string}:${string}`,
    ability,
    budget,
    createSchemeClients: () => [fakeScheme()],
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    explorerBaseUrl: "https://stellar.expert/explorer/testnet/tx",
  });

  return { pay, budget, fetchImpl };
}

describe("paid_request", () => {
  it("pays a 402 and reports the settlement, the price and the budget", async () => {
    const { pay } = harness([paymentRequired(), settled()]);

    const result = await pay({ url: RESOURCE, query: { thing: "example" } });

    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ answer: 42 });
    expect(result.settlement).toMatchObject({
      success: true,
      transaction: "abc123",
      payer: PAYER,
      amountAtomic: "10000",
      usd: "0.001",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/abc123",
    });
    expect(result.budget).toMatchObject({ spent: "0.001", remaining: "0.049" });
  });

  it("passes the query parameters the agent built onto the URL", async () => {
    const { pay, fetchImpl } = harness([paymentRequired(), settled()]);

    await pay({ url: RESOURCE, query: { thing: "a value" } });

    const request = fetchImpl.mock.calls[0][0] as unknown as Request;
    expect(new URL(request.url).searchParams.get("thing")).toBe("a value");
  });

  it("returns the body untouched when the endpoint charges nothing", async () => {
    const free = new Response(JSON.stringify({ free: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { pay, budget } = harness([free]);

    const result = await pay({ url: RESOURCE });

    expect(result.paid).toBe(false);
    expect(result.settlement).toBeUndefined();
    expect(budget.spent).toBe(0n);
  });

  it("refuses a price above the per-call cap and quotes it", async () => {
    const { pay, budget } = harness([paymentRequired([requirements({ amount: "200000" })])]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "cap_exceeded",
      details: { quote: { usd: "0.02", amountAtomic: "200000" } },
    });
    // Nothing was signed, so nothing was charged.
    expect(budget.spent).toBe(0n);
  });

  it("refuses once the session budget is spent", async () => {
    const { pay, budget } = harness([paymentRequired(), settled(), paymentRequired()], {
      perCall: "0.01",
      session: "0.001",
    });

    await pay({ url: RESOURCE });
    expect(budget.remaining).toBe(0n);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "session_budget_exhausted",
    });
  });

  it("refuses an asset outside the allowlist and names what it can pay", async () => {
    const { pay } = harness([paymentRequired([requirements({ asset: XLM })])]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "asset_not_allowed",
      details: { offered: [`${XLM} on ${NETWORK}`] },
    });
  });

  it("picks the payable option when the resource offers a mix", async () => {
    const { pay } = harness([
      paymentRequired([requirements({ asset: XLM, amount: "1" }), requirements()]),
      settled(),
    ]);

    const result = await pay({ url: RESOURCE });
    expect(result.settlement).toMatchObject({ asset: TESTNET_USDC });
  });

  it("reports a network it has no scheme for", async () => {
    const { pay } = harness([paymentRequired([requirements({ network: "eip155:8453" })])]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "network_not_supported",
      details: { offered: ["exact on eip155:8453"] },
    });
  });

  it("tells an unsignable scheme apart from an unknown network", async () => {
    // This wallet registers no client scheme for `subscription`. An unknown
    // scheme and an unknown network reach us as one message from the client, so
    // the 402 we recorded is what makes the distinction, and the agent must not
    // be told the network was wrong when the network was fine.
    const { pay } = harness([paymentRequired([requirements({ scheme: "subscription" })])]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "scheme_not_supported",
      details: { offered: [`subscription on ${NETWORK}`] },
    });
  });

  it("refuses an unsignable scheme even when the asset is allowlisted", async () => {
    const { pay, budget } = harness([
      paymentRequired([requirements({ scheme: "subscription", asset: TESTNET_USDC })]),
    ]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "scheme_not_supported",
    });
    expect(budget.spent).toBe(0n);
  });

  it("picks the signable scheme when the resource offers both", async () => {
    const { pay } = harness([
      paymentRequired([requirements({ scheme: "subscription", amount: "1" }), requirements()]),
      settled(),
    ]);

    const result = await pay({ url: RESOURCE });
    expect(result.settlement).toMatchObject({ success: true, amountAtomic: "10000" });
  });

  it("rejects a relative url and a non-http scheme", async () => {
    const { pay } = harness([]);

    await expect(pay({ url: "/paid/thing" })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(pay({ url: "file:///etc/passwd" })).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("rejects a caller-supplied payment header", async () => {
    const { pay } = harness([]);

    await expect(
      pay({ url: RESOURCE, headers: { "Payment-Signature": "forged" } }),
    ).rejects.toMatchObject({ code: "forbidden_header" });
  });

  it("surfaces a failed settlement with the facilitator's own reason", async () => {
    const failed = new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: false,
          transaction: "",
          network: NETWORK,
          errorReason: "insufficient_funds",
        }),
      },
    });
    const { pay, budget } = harness([paymentRequired(), failed]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "settle_failed",
      details: { errorReason: "insufficient_funds" },
    });
    // Charged anyway: the payment was signed and sent.
    expect(budget.spent).toBe(toAtomic("0.001", BUDGET_DECIMALS));
  });

  it("calls a lost answer indeterminate once a payment has been signed", async () => {
    const queue = [paymentRequired()];
    const fetchImpl = vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("socket hang up");
      return next;
    });
    const budget = new SessionBudget(
      toAtomic("0.01", BUDGET_DECIMALS),
      toAtomic("0.05", BUDGET_DECIMALS),
    );
    const pay = createPayer({
      network: NETWORK as `${string}:${string}`,
      ability,
      budget,
      createSchemeClients: () => [fakeScheme()],
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "settle_indeterminate",
    });
    expect(budget.spent).toBe(toAtomic("0.001", BUDGET_DECIMALS));
  });

  it("calls a lost answer a transport error before anything is signed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const budget = new SessionBudget(
      toAtomic("0.01", BUDGET_DECIMALS),
      toAtomic("0.05", BUDGET_DECIMALS),
    );
    const pay = createPayer({
      network: NETWORK as `${string}:${string}`,
      ability,
      budget,
      createSchemeClients: () => [fakeScheme()],
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({ code: "transport_error" });
    expect(budget.spent).toBe(0n);
  });

  it("reports an upstream failure after payment with its status", async () => {
    const broken = new Response("upstream exploded", { status: 502 });
    const { pay } = harness([paymentRequired(), broken]);

    await expect(pay({ url: RESOURCE })).rejects.toMatchObject({
      code: "upstream_error",
      details: { status: 502, paymentWasSigned: true },
    });
  });

  it("hands the tool's structured error to the client, never a raw throw", async () => {
    const client = await connect({
      pay: async () => {
        const { pay } = harness([paymentRequired([requirements({ amount: "200000" })])]);
        return pay({ url: RESOURCE });
      },
    });

    const result = await client.callTool({ name: "paid_request", arguments: { url: RESOURCE } });
    const body = resultBody(result) as { error: { code: string; reason: string } };

    expect(isError(result)).toBe(true);
    expect(body.error.code).toBe("cap_exceeded");
    expect(body.error.reason).toContain("per-call limit");
  });
});
