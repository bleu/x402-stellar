import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

/**
 * Resource-server handler for the `upto` scheme on Stellar.
 *
 * Pricing and the money-parser chain are the same as `exact`, so this delegates
 * both to that scheme and only changes the scheme name and the addresses it
 * publishes. Delegation rather than inheritance because `ExactStellarScheme`
 * types its `scheme` as the literal `"exact"`.
 *
 * The two addresses are what let a buyer build its authorization from the 402
 * alone, with nothing agreed out of band.
 */
export class UptoStellarServerScheme implements SchemeNetworkServer {
  readonly scheme = "upto";

  private readonly exact = new ExactStellarScheme();

  parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    return this.exact.parsePrice(price, network);
  }

  /**
   * Stellar assets carry seven decimals. Core asks for this when a settlement
   * override is written as a dollar price, and falls back to six without it,
   * which would settle a tenth of what the seller meant.
   */
  getAssetDecimals(): number {
    return 7;
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    const enhanced = await this.exact.enhancePaymentRequirements(
      paymentRequirements,
      supportedKind,
      facilitatorExtensions,
    );
    const { contract, settler } = supportedKind.extra ?? {};

    return {
      ...enhanced,
      extra: {
        ...enhanced.extra,
        ...(typeof contract === "string" && { contract }),
        ...(typeof settler === "string" && { settler }),
      },
    };
  }
}
