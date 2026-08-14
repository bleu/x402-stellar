import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { parseUptoPayload, type UptoStellarPayload } from "./payload.js";
import { UptoStellarScheme } from "./facilitator/index.js";

const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const BUYER = "GCRXEB4BNIMRSNUZNAXQS2S7ZV236ZZEAENFYUOZLLTIQ3QMTNQZQ55Y";
const MERCHANT = "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO";
const CONTRACT = "CARIDBM7FJQHMHJVAWNAUG5IF5FXOLWBYGHLHMQBIX7MPN5BSPJHDR43";

function validPayload(overrides: Partial<UptoStellarPayload> = {}): UptoStellarPayload {
  return {
    authorization: {
      from: BUYER,
      payTo: MERCHANT,
      asset: ASSET,
      maxAmount: "1000000",
      validAfterLedger: 0,
      deadlineLedger: 9_999_999,
      expirationLedger: 9_999_999,
      salt: "07".repeat(32),
    },
    authEntryXdr: "AAAA",
    ...overrides,
  };
}

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "upto",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1000000",
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

function scheme(): UptoStellarScheme {
  return new UptoStellarScheme({
    contractId: CONTRACT,
    facilitatorSecret: Keypair.random().secret(),
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: "stellar:testnet",
  });
}

function payload(
  p: UptoStellarPayload,
  accepted: PaymentRequirements = requirements(),
): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: p as unknown as Record<string, unknown>,
  };
}

describe("parseUptoPayload", () => {
  it("accepts a well-formed payload", () => {
    const result = parseUptoPayload(validPayload());
    expect("payload" in result).toBe(true);
  });

  it("rejects a missing auth entry", () => {
    const result = parseUptoPayload(validPayload({ authEntryXdr: "" }));
    expect(result).toEqual({ error: expect.stringContaining("authEntryXdr") });
  });

  it("rejects a bad salt", () => {
    const bad = validPayload();
    bad.authorization.salt = "xyz";
    const result = parseUptoPayload(bad);
    expect(result).toEqual({ error: expect.stringContaining("salt") });
  });

  it("rejects a non-integer maxAmount", () => {
    const bad = validPayload();
    (bad.authorization as { maxAmount: string }).maxAmount = "1.5";
    const result = parseUptoPayload(bad);
    expect(result).toEqual({ error: expect.stringContaining("maxAmount") });
  });
});

describe("UptoStellarScheme.verify pre-network checks", () => {
  it("rejects an asset mismatch", async () => {
    const res = await scheme().verify(payload(validPayload()), requirements({ asset: "COTHER" }));
    expect(res).toMatchObject({ isValid: false, invalidReason: "asset_mismatch" });
  });

  it("rejects a recipient mismatch", async () => {
    const res = await scheme().verify(payload(validPayload()), requirements({ payTo: "GOTHER" }));
    expect(res).toMatchObject({ isValid: false, invalidReason: "recipient_mismatch" });
  });

  it("rejects a cap mismatch", async () => {
    const res = await scheme().verify(payload(validPayload()), requirements({ amount: "500000" }));
    expect(res).toMatchObject({ isValid: false, invalidReason: "cap_mismatch" });
  });

  it("rejects an invalid payload shape", async () => {
    const res = await scheme().verify(
      { x402Version: 2, accepted: requirements(), payload: { nope: true } },
      requirements(),
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });
});

describe("UptoStellarScheme.getExtra", () => {
  it("names the contract and the settler the buyer must build against", () => {
    const facilitator = Keypair.random();
    const extra = new UptoStellarScheme({
      contractId: CONTRACT,
      facilitatorSecret: facilitator.secret(),
      rpcUrl: "https://soroban-testnet.stellar.org",
      network: "stellar:testnet",
    }).getExtra();

    expect(extra).toMatchObject({ contract: CONTRACT, settler: facilitator.publicKey() });
  });
});

describe("UptoStellarScheme.settle pre-network checks", () => {
  it("rejects an amount above the signed cap", async () => {
    const res = await scheme().settle(payload(validPayload()), requirements({ amount: "2000000" }));
    expect(res).toMatchObject({ success: false, errorReason: "amount_exceeds_max" });
  });

  it("rejects a settle amount that never resolved to atomic units", async () => {
    const res = await scheme().settle(payload(validPayload()), requirements({ amount: "$0.003" }));
    expect(res).toMatchObject({ success: false, errorReason: "amount_exceeds_max" });
  });

  it("rejects a quoted ceiling that is not the one the buyer signed", async () => {
    // The settle call sees a reduced requirements.amount, so the only surviving
    // record of what was quoted is payload.accepted. Anything downstream that
    // reads it as the price -- the catalog does -- needs it pinned to the
    // signature rather than taken on the client's word.
    const res = await scheme().settle(
      payload(validPayload(), requirements({ amount: "9999999" })),
      requirements({ amount: "10000" }),
    );
    expect(res).toMatchObject({ success: false, errorReason: "cap_mismatch" });
  });
});
