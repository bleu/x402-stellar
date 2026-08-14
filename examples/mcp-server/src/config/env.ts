import { AssetAllowlist, BUDGET_DECIMALS, parsePayableAssets, toAtomic } from "../assets.js";

const EXPLORER_BASE: Record<string, string> = {
  "stellar:testnet": "https://stellar.expert/explorer/testnet/tx",
  "stellar:pubnet": "https://stellar.expert/explorer/public/tx",
};

export class Env {
  /** The buyer's secret key. Read from this package's own .env, never from the MCP client config. */
  static get stellarPrivateKey(): string {
    const key = process.env.STELLAR_PRIVATE_KEY;
    if (!key) {
      throw new Error("STELLAR_PRIVATE_KEY is required. See .env.example");
    }
    return key;
  }

  static get stellarNetwork(): `${string}:${string}` {
    return (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;
  }

  /** Soroban RPC, used to simulate the settle an `upto` ceiling authorizes. */
  static get stellarRpcUrl(): string {
    return process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  }

  /** The Bazaar this server searches. The only endpoint it is told about. */
  static get facilitatorUrl(): string {
    return (process.env.FACILITATOR_URL ?? "http://localhost:4022").replace(/\/+$/, "");
  }

  static get assets(): AssetAllowlist {
    return new AssetAllowlist(parsePayableAssets(process.env.PAYABLE_ASSETS));
  }

  /** Most one call may spend, in whole USD-pegged tokens. */
  static get maxPayment(): bigint {
    return toAtomic(process.env.MAX_PAYMENT ?? "0.01", BUDGET_DECIMALS);
  }

  /** Most the whole session may spend, in whole USD-pegged tokens. */
  static get sessionBudget(): bigint {
    return toAtomic(process.env.SESSION_BUDGET ?? "0.05", BUDGET_DECIMALS);
  }

  static get explorerBaseUrl(): string | undefined {
    return EXPLORER_BASE[Env.stellarNetwork];
  }
}
