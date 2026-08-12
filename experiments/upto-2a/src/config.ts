import "dotenv/config";
import { Asset, Networks } from "@stellar/stellar-sdk";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

export const BUYER_SECRET = required("BUYER_SECRET");
export const FACILITATOR_SECRET = required("FACILITATOR_SECRET");
export const MERCHANT_ADDRESS = required("MERCHANT_ADDRESS");

// Circle testnet USDC; the SAC contract id is derived, not hardcoded.
const ASSET_CODE = process.env.ASSET_CODE ?? "USDC";
const ASSET_ISSUER = process.env.ASSET_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC_ASSET = new Asset(ASSET_CODE, ASSET_ISSUER);
export const TOKEN_CONTRACT_ID = USDC_ASSET.contractId(NETWORK_PASSPHRASE);

// Amounts are in the SAC's 7-decimal units: 1 USDC = 10_000_000.
export const CAP = BigInt(process.env.CAP ?? 10_000_000);
export const ACTUAL = BigInt(process.env.ACTUAL ?? 3_000_000);

export const SIGNED_AUTH_FILE = new URL("../signed-approve.json", import.meta.url).pathname;
