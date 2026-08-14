import type { AssetAllowlist, PayableAsset } from "./assets.js";

/**
 * Schemes this wallet can sign for, matching the client schemes it registers.
 * With `upto` it signs a ceiling and the seller charges at or below it, so the
 * price quoted for such a row is the most the call could cost.
 */
export const SIGNABLE_SCHEMES: readonly string[] = ["exact", "upto"];

/** One payment option as it appears in a 402 or in a catalog row's `accepts`. */
export interface PaymentOptionLike {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
}

/**
 * What this wallet can actually pay: an asset allowlist and a set of schemes.
 *
 * Both halves live here so search and payment answer the question identically.
 * When they disagreed, search could offer an endpoint that `paid_request` then
 * refused, which is exactly what the `payable` flag exists to prevent.
 */
export class PaymentAbility {
  constructor(
    readonly assets: AssetAllowlist,
    private readonly schemes: readonly string[] = SIGNABLE_SCHEMES,
  ) {}

  /** The declared asset for an option, or undefined when it is not payable. */
  assetFor(option: PaymentOptionLike): PayableAsset | undefined {
    return this.assets.find(option.network, option.asset);
  }

  signsScheme(scheme: string | undefined): boolean {
    // An option with no scheme is malformed rather than unsupported; the
    // payment path rejects it on its own terms.
    return scheme === undefined || this.schemes.includes(scheme);
  }

  canPay(option: PaymentOptionLike): boolean {
    return this.signsScheme(option.scheme) && this.assetFor(option) !== undefined;
  }

  /** Rendered for tool descriptions and refusal messages. */
  describe(): string {
    return `${this.assets.describe()} (scheme${this.schemes.length > 1 ? "s" : ""}: ${this.schemes.join(", ")})`;
  }
}
