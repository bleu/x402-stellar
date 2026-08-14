import { randomBytes } from "node:crypto";
import { authorizeEntry, Keypair, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type {
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { getNetworkPassphrase } from "@x402/stellar";

import { settleOperation, type UptoAuthorization, type UptoStellarPayload } from "../payload.js";

export interface BuildUptoPayloadParams {
  buyerSecret: string;
  contractId: string;
  payTo: string;
  asset: string;
  maxAmount: bigint;
  rpcUrl: string;
  network: `${string}:${string}`;
  /**
   * Facilitator address (`G...`) that will submit the settle. Used as the
   * simulation source so the buyer's auth is a detached address credential the
   * buyer can sign offline, rather than collapsing into the source-account
   * credential (which happens when the buyer is the source).
   */
  facilitatorAddress: string;
  /** Ledgers from now until the buyer's authorization expires (default ~24h). */
  validityWindowLedgers?: number;
}

/**
 * Builds an `upto` payment payload from the buyer side. The buyer signs one
 * auth entry that authorizes the settle call (amount excluded) and the nested
 * `approve`, so the same signature settles any amount up to the cap. Nothing is
 * submitted here — only a read-only simulation to obtain the entry to sign.
 */
export async function buildUptoPayload(
  params: BuildUptoPayloadParams,
): Promise<UptoStellarPayload> {
  const buyer = Keypair.fromSecret(params.buyerSecret);
  const passphrase = getNetworkPassphrase(params.network);
  const server = new rpc.Server(params.rpcUrl);

  const { sequence: ledger } = await server.getLatestLedger();
  const window = params.validityWindowLedgers ?? 17_280;

  const auth: UptoAuthorization = {
    from: buyer.publicKey(),
    payTo: params.payTo,
    asset: params.asset,
    maxAmount: params.maxAmount.toString(),
    validAfterLedger: 0,
    deadlineLedger: ledger + window,
    expirationLedger: ledger + window,
    salt: randomBytes(32).toString("hex"),
  };
  const authValidUntil = ledger + window;

  // Simulate settle (placeholder amount = cap) to get the auth entries the host
  // requires. The signed entry excludes the amount, so it works for any actual
  // amount the facilitator later settles. The facilitator is the source so the
  // buyer's auth is a detached, signable address credential.
  const account = await server.getAccount(params.facilitatorAddress);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: passphrase,
  })
    .addOperation(settleOperation(params.contractId, auth, params.maxAmount))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`upto payload simulation failed: ${sim.error}`);
  }

  const entries = sim.result?.auth ?? [];
  const buyerEntries = entries.filter(
    (e) => e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
  );
  if (buyerEntries.length !== 1) {
    throw new Error(`expected exactly one buyer auth entry, got ${buyerEntries.length}`);
  }

  const signed = await authorizeEntry(buyerEntries[0], buyer, authValidUntil, passphrase);

  return { authorization: auth, authEntryXdr: signed.toXDR("base64") };
}

export type UptoPayloadBuilder = (params: BuildUptoPayloadParams) => Promise<UptoStellarPayload>;

export interface UptoClientSchemeOptions {
  /** Buyer secret key, `S...`. It signs the ceiling and never leaves here. */
  buyerSecret: string;
  /** Soroban RPC URL used for the read-only simulation. */
  rpcUrl: string;
  network: Network;
  /** Ledgers from now until the buyer's authorization expires. */
  validityWindowLedgers?: number;
  /** How the payload gets built. Injected so tests need no chain. */
  build?: UptoPayloadBuilder;
}

/**
 * Client handler for the `upto` scheme on Stellar.
 *
 * Everything it needs comes from the 402 itself: the ceiling to sign, who may
 * receive it, in which asset, and which contract and settler account the
 * authorization is built against. Nothing is agreed out of band, so this signs
 * for any resource server whose facilitator serves the scheme.
 */
export class UptoStellarClientScheme implements SchemeNetworkClient {
  readonly scheme = "upto";

  private readonly build: UptoPayloadBuilder;

  constructor(private readonly options: UptoClientSchemeOptions) {
    this.build = options.build ?? buildUptoPayload;
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const contractId = readAddress(paymentRequirements, "contract");
    const settler = readAddress(paymentRequirements, "settler");

    const payload = await this.build({
      buyerSecret: this.options.buyerSecret,
      contractId,
      payTo: paymentRequirements.payTo,
      asset: paymentRequirements.asset,
      maxAmount: BigInt(paymentRequirements.amount),
      rpcUrl: this.options.rpcUrl,
      network: this.options.network as `${string}:${string}`,
      // The settler submits the settle, so the buyer must simulate against it.
      // Simulating as itself collapses the authorization into a source-account
      // credential, which leaves nothing detached to sign offline.
      facilitatorAddress: settler,
      ...(this.options.validityWindowLedgers === undefined
        ? {}
        : { validityWindowLedgers: this.options.validityWindowLedgers }),
    });

    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}

function readAddress(requirements: PaymentRequirements, key: "contract" | "settler"): string {
  const value = requirements.extra?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `upto payment requirements are missing extra.${key}; the facilitator must advertise it at /supported`,
    );
  }
  return value;
}
