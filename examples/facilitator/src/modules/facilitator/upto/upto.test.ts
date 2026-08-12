import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { parseUptoPayload, type UptoStellarPayload } from "./payload.js";
import { UptoStellarScheme } from "./scheme.js";

const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const BUYER = "GCRXEB4BNIMRSNUZNAXQS2S7ZV236ZZEAENFYUOZLLTIQ3QMTNQZQ55Y";
const MERCHANT = "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO";

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
    contractId: "CARIDBM7FJQHMHJVAWNAUG5IF5FXOLWBYGHLHMQBIX7MPN5BSPJHDR43",
    facilitatorSecret: Keypair.random().secret(),
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: "stellar:testnet",
  });
}

function payload(p: UptoStellarPayload): PaymentPayload {
  return { x402Version: 2, accepted: requirements(), payload: p as unknown as Record<string, unknown> };
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

  it("rejects an amount above the cap", async () => {
    const res = await scheme().verify(payload(validPayload({ amount: "2000000" })), requirements());
    expect(res).toMatchObject({ isValid: false, invalidReason: "amount_exceeds_max" });
  });

  it("rejects an invalid payload shape", async () => {
    const res = await scheme().verify(
      { x402Version: 2, accepted: requirements(), payload: { nope: true } },
      requirements(),
    );
    expect(res).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });
});
