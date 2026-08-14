import { randomBytes } from "node:crypto";
import { authorizeEntry, Keypair, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
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
  /** Optional actual amount to request; defaults to the cap. */
  amount?: bigint;
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

  return {
    authorization: auth,
    authEntryXdr: signed.toXDR("base64"),
    ...(params.amount === undefined ? {} : { amount: params.amount.toString() }),
  };
}
