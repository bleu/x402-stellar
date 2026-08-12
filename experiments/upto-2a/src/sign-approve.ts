import { writeFileSync } from "node:fs";
import {
  Address,
  Keypair,
  authorizeInvocation,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  BUYER_SECRET,
  CAP,
  FACILITATOR_SECRET,
  NETWORK_PASSPHRASE,
  RPC_URL,
  SIGNED_AUTH_FILE,
  TOKEN_CONTRACT_ID,
} from "./config.js";

// Buyer role. The only network access is reading the latest ledger number;
// the buyer never builds or submits a transaction.
const buyer = Keypair.fromSecret(BUYER_SECRET);
const spender = Keypair.fromSecret(FACILITATOR_SECRET).publicKey();

const server = new rpc.Server(RPC_URL);
const { sequence: currentLedger } = await server.getLatestLedger();

const signatureExpirationLedger = currentLedger + 720; // ~1h
const allowanceExpirationLedger = currentLedger + 17280; // ~24h

const invocation = new xdr.SorobanAuthorizedInvocation({
  function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(TOKEN_CONTRACT_ID).toScAddress(),
      functionName: "approve",
      args: [
        new Address(buyer.publicKey()).toScVal(),
        new Address(spender).toScVal(),
        nativeToScVal(CAP, { type: "i128" }),
        nativeToScVal(allowanceExpirationLedger, { type: "u32" }),
      ],
    }),
  ),
  subInvocations: [],
});

const entry = await authorizeInvocation(
  buyer,
  signatureExpirationLedger,
  invocation,
  buyer.publicKey(),
  NETWORK_PASSPHRASE,
);

const payload = {
  authEntryXdr: entry.toXDR("base64"),
  buyer: buyer.publicKey(),
  spender,
  cap: CAP.toString(),
  allowanceExpirationLedger,
  signatureExpirationLedger,
  tokenContractId: TOKEN_CONTRACT_ID,
};

writeFileSync(SIGNED_AUTH_FILE, JSON.stringify(payload, null, 2));
console.log(`Signed approve auth entry written to ${SIGNED_AUTH_FILE}`);
console.log(payload);
