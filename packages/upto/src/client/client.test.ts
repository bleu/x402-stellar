import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { UptoStellarClientScheme } from "./index.js";
import type { BuildUptoPayloadParams } from "./index.js";
import type { UptoStellarPayload } from "../payload.js";

const CONTRACT = "CARIDBM7FJQHMHJVAWNAUG5IF5FXOLWBYGHLHMQBIX7MPN5BSPJHDR43";
const SETTLER = "GATGWGWP2BLUGUBJG4DMYB4LRZNWFUPUE6JT7HDDLBYQCIJ2LPRTCLXD";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MERCHANT = "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO";
const BUYER_SECRET = "SDXAJ6QBBLLPVQFXOSWJHFDGKQXPS6HRVXKUOTBAYRJLPWNQGZXMQEJK";

const BUILT: UptoStellarPayload = {
  authorization: {
    from: "GCRXEB4BNIMRSNUZNAXQS2S7ZV236ZZEAENFYUOZLLTIQ3QMTNQZQ55Y",
    payTo: MERCHANT,
    asset: ASSET,
    maxAmount: "30000",
    validAfterLedger: 0,
    deadlineLedger: 9_999_999,
    expirationLedger: 9_999_999,
    salt: "07".repeat(32),
  },
  authEntryXdr: "AAAA",
};

function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "upto",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "30000",
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: { contract: CONTRACT, settler: SETTLER, ...extra },
  };
}

function schemeWith(build: (params: BuildUptoPayloadParams) => Promise<UptoStellarPayload>) {
  return new UptoStellarClientScheme({
    buyerSecret: BUYER_SECRET,
    rpcUrl: "https://soroban-testnet.stellar.org",
    network: "stellar:testnet",
    build,
  });
}

describe("UptoStellarClientScheme", () => {
  it("signs the ceiling the resource quoted, bound to its recipient and asset", async () => {
    const build = vi.fn().mockResolvedValue(BUILT);

    await schemeWith(build).createPaymentPayload(2, requirements());

    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAmount: 30000n,
        payTo: MERCHANT,
        asset: ASSET,
        contractId: CONTRACT,
      }),
    );
  });

  it("simulates against the settler, so the authorization stays detached", async () => {
    const build = vi.fn().mockResolvedValue(BUILT);

    await schemeWith(build).createPaymentPayload(2, requirements());

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ facilitatorAddress: SETTLER }));
  });

  it("returns the built authorization as the payment payload", async () => {
    const result = await schemeWith(vi.fn().mockResolvedValue(BUILT)).createPaymentPayload(
      2,
      requirements(),
    );

    expect(result).toEqual({ x402Version: 2, payload: BUILT });
  });

  it("refuses a 402 that does not name the settlement contract", async () => {
    const build = vi.fn();

    await expect(
      schemeWith(build).createPaymentPayload(2, requirements({ contract: undefined })),
    ).rejects.toThrow(/contract/);
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a 402 that does not name the settler", async () => {
    const build = vi.fn();

    await expect(
      schemeWith(build).createPaymentPayload(2, requirements({ settler: undefined })),
    ).rejects.toThrow(/settler/);
    expect(build).not.toHaveBeenCalled();
  });
});
