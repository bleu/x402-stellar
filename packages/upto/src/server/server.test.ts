import type { PaymentRequirements, SupportedKind } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { UptoStellarServerScheme } from "./index.js";

const CONTRACT = "CARIDBM7FJQHMHJVAWNAUG5IF5FXOLWBYGHLHMQBIX7MPN5BSPJHDR43";
const SETTLER = "GATGWGWP2BLUGUBJG4DMYB4LRZNWFUPUE6JT7HDDLBYQCIJ2LPRTCLXD";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MERCHANT = "GAZNKV4O7FDQX4FXXAQRSG4VMS6HGA72MI2YAGZOYP26BPZRPGZLGZZO";

function supportedKind(extra: Record<string, unknown>): SupportedKind {
  return { x402Version: 2, scheme: "upto", network: "stellar:testnet", extra };
}

function baseRequirements(): PaymentRequirements {
  return {
    scheme: "upto",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "30000",
    payTo: MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

describe("UptoStellarServerScheme", () => {
  it("serves the upto scheme", () => {
    expect(new UptoStellarServerScheme().scheme).toBe("upto");
  });

  it("puts the contract and the settler in the 402 so the buyer needs no side channel", async () => {
    const enhanced = await new UptoStellarServerScheme().enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({ areFeesSponsored: true, contract: CONTRACT, settler: SETTLER }),
      [],
    );

    expect(enhanced.extra).toMatchObject({ contract: CONTRACT, settler: SETTLER });
  });

  it("keeps what the exact scheme already published", async () => {
    const enhanced = await new UptoStellarServerScheme().enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({ areFeesSponsored: true, contract: CONTRACT, settler: SETTLER }),
      [],
    );

    expect(enhanced.extra).toMatchObject({ areFeesSponsored: true });
  });

  it("prices a ceiling in USDC atomic units, as the exact scheme does", async () => {
    const priced = await new UptoStellarServerScheme().parsePrice("$0.003", "stellar:testnet");

    expect(priced.amount).toBe("30000");
  });

  it("reports Stellar's seven decimals, so a dollar override is not scaled as six", () => {
    const decimals = new UptoStellarServerScheme().getAssetDecimals();

    expect(decimals).toBe(7);
  });
});
