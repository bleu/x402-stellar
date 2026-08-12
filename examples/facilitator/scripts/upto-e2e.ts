/**
 * End-to-end proof for the upto scheme on testnet (STE-60).
 *
 * Buyer builds and signs an upto payload, then the UptoStellarScheme verifies
 * it and settles a partial amount on-chain. Run against testnet with the
 * Phase 1 keys. Not part of the automated test suite (needs live keys + RPC).
 *
 *   tsx --env-file=<path-to-.env> scripts/upto-e2e.ts
 *
 * Env: BUYER_SECRET, FACILITATOR_SECRET (or FACILITATOR_STELLAR_PRIVATE_KEY),
 * MERCHANT_ADDRESS, UPTO_CONTRACT_ID (or CONTRACT_ID), optional STELLAR_RPC_URL,
 * STELLAR_NETWORK, ASSET_CODE, ASSET_ISSUER, CAP, ACTUAL.
 */
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { buildUptoPayload } from "../src/modules/facilitator/upto/client.js";
import { UptoStellarScheme } from "../src/modules/facilitator/upto/scheme.js";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const network = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const buyerSecret = req("BUYER_SECRET");
const facilitatorSecret = req("FACILITATOR_SECRET", process.env.FACILITATOR_STELLAR_PRIVATE_KEY);
const merchant = req("MERCHANT_ADDRESS");
const contractId = req("UPTO_CONTRACT_ID", process.env.CONTRACT_ID);

const passphrase = network.endsWith(":testnet") ? Networks.TESTNET : Networks.PUBLIC;
const asset = new Asset(
  process.env.ASSET_CODE ?? "USDC",
  process.env.ASSET_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);
const assetContractId = asset.contractId(passphrase);

const cap = BigInt(process.env.CAP ?? 10_000_000); // 1 USDC
const actual = BigInt(process.env.ACTUAL ?? 4_000_000); // 0.4 USDC

const requirements: PaymentRequirements = {
  scheme: "upto",
  network,
  asset: assetContractId,
  amount: cap.toString(),
  payTo: merchant,
  maxTimeoutSeconds: 60,
  extra: {},
};

async function main(): Promise<void> {
  console.log("Building buyer upto payload (signs settle auth entry offline)...");
  const uptoPayload = await buildUptoPayload({
    buyerSecret,
    contractId,
    payTo: merchant,
    asset: assetContractId,
    maxAmount: cap,
    rpcUrl,
    network,
    facilitatorAddress: Keypair.fromSecret(facilitatorSecret).publicKey(),
    amount: actual,
  });

  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: uptoPayload as unknown as Record<string, unknown>,
  };

  const scheme = new UptoStellarScheme({
    contractId,
    facilitatorSecret,
    rpcUrl,
    network,
  });

  console.log("verify...");
  const verify = await scheme.verify(payload, requirements);
  console.log("  ", JSON.stringify(verify));
  if (!verify.isValid) throw new Error(`verify rejected: ${verify.invalidReason}`);

  console.log(`settle ${actual} of cap ${cap}...`);
  const settle = await scheme.settle(payload, requirements);
  console.log("  ", JSON.stringify(settle));
  if (!settle.success) throw new Error(`settle failed: ${settle.errorReason}`);

  console.log(`OK. tx ${settle.transaction}, settled ${settle.amount}, payer ${settle.payer}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
