import { ToolError } from "./errors.js";

/** One payable asset: a network, its SEP-41 contract, and its atomic scale. */
export interface PayableAsset {
  network: string;
  asset: string;
  decimals: number;
  symbol: string;
}

/**
 * Canonical scale for budget arithmetic. Every payable asset is declared to be a
 * USD stablecoin, so spends across assets are commensurable once normalised to
 * this many decimals. Same assumption the facilitator's price feed documents.
 */
export const BUDGET_DECIMALS = 7;

/**
 * Testnet USDC, the asset the demo pays in. `PaymentRequirements` carries no
 * decimals field and @x402/stellar defaults to 7.
 */
export const DEFAULT_PAYABLE_ASSETS: PayableAsset[] = [
  {
    network: "stellar:testnet",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    decimals: 7,
    symbol: "USDC",
  },
];

/**
 * Parses `PAYABLE_ASSETS`, a comma-separated list of
 * `network|contract|decimals|symbol` entries. An asset absent from the list is
 * never signed for, which is what makes a hostile 402 unable to get us to
 * authorise a transfer of something we cannot value.
 */
export function parsePayableAssets(raw: string | undefined): PayableAsset[] {
  if (!raw || raw.trim().length === 0) return DEFAULT_PAYABLE_ASSETS;

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [network, asset, decimals, symbol] = entry.split("|").map((part) => part?.trim());
      const scale = Number(decimals);
      if (!network || !asset || !Number.isInteger(scale) || scale < 0 || scale > 18) {
        throw new Error(
          `Invalid PAYABLE_ASSETS entry "${entry}". Expected network|contract|decimals|symbol.`,
        );
      }
      return { network, asset, decimals: scale, symbol: symbol || asset.slice(0, 4) };
    });
}

export class AssetAllowlist {
  constructor(private readonly assets: PayableAsset[]) {}

  /** The declared asset for a (network, contract) pair, or undefined. */
  find(network: string | undefined, asset: string | undefined): PayableAsset | undefined {
    if (!network || !asset) return undefined;
    return this.assets.find((entry) => entry.network === network && entry.asset === asset);
  }

  allows(network: string | undefined, asset: string | undefined): boolean {
    return this.find(network, asset) !== undefined;
  }

  /** Rendered for tool descriptions, so the agent knows what it can pay in. */
  describe(): string {
    return this.assets.map((entry) => `${entry.symbol} on ${entry.network}`).join(", ");
  }

  list(): readonly PayableAsset[] {
    return this.assets;
  }
}

/** Whole tokens to atomic units, without going through a float. */
export function toAtomic(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount "${amount}".`);
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount "${amount}" has more than ${decimals} decimal places.`);
  }

  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** Atomic units back to a whole-token decimal string, no trailing zeroes. */
export function fromAtomic(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Normalises an asset's atomic amount to the canonical budget scale. */
export function toBudgetUnits(atomic: bigint, decimals: number): bigint {
  if (decimals === BUDGET_DECIMALS) return atomic;
  return decimals < BUDGET_DECIMALS
    ? atomic * 10n ** BigInt(BUDGET_DECIMALS - decimals)
    : atomic / 10n ** BigInt(decimals - BUDGET_DECIMALS);
}

/** Parses an atomic amount string from a PaymentRequirements entry. */
export function parseAtomicAmount(amount: unknown): bigint {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    throw new ToolError(
      "payment_required_malformed",
      `Payment requirements carried a non-integer amount: ${String(amount)}`,
    );
  }
  return BigInt(amount);
}
