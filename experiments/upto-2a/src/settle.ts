import { readFileSync } from "node:fs";
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  Address,
} from "@stellar/stellar-sdk";
import {
  ACTUAL,
  FACILITATOR_SECRET,
  MERCHANT_ADDRESS,
  NETWORK_PASSPHRASE,
  RPC_URL,
  SIGNED_AUTH_FILE,
  TOKEN_CONTRACT_ID,
  USDC_ASSET,
} from "./config.js";

// Facilitator role: submit the buyer-signed approve, then pull the actual
// amount with transfer_from. Nothing here binds the destination or the
// amount below the cap — that is the trust gap this experiment documents.
const facilitator = Keypair.fromSecret(FACILITATOR_SECRET);
const server = new rpc.Server(RPC_URL);

const signed = JSON.parse(readFileSync(SIGNED_AUTH_FILE, "utf-8")) as {
  authEntryXdr: string;
  buyer: string;
  spender: string;
  cap: string;
  allowanceExpirationLedger: number;
};

if (signed.spender !== facilitator.publicKey()) {
  throw new Error("Signed entry names a different spender than FACILITATOR_SECRET");
}

async function submit(op: xdr.Operation, label: string): Promise<string> {
  const account = await server.getAccount(facilitator.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: (Number(BASE_FEE) * 10).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${label} simulation failed: ${sim.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(facilitator);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${label} submit failed: ${JSON.stringify(sent.errorResult)}`);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${label} failed on-chain: ${result.status}`);
  }
  console.log(`${label}: ${sent.hash}`);
  return sent.hash;
}

// 1. approve — buyer's offline-signed auth entry, facilitator as tx source.
// SKIP_APPROVE=1 reuses an allowance already on-chain (the signed entry's
// nonce is single-use, so a second approve submit fails with Auth,ExistingValue).
const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(signed.authEntryXdr, "base64");
if (process.env.SKIP_APPROVE !== "1") {
  await submit(
    Operation.invokeContractFunction({
      contract: TOKEN_CONTRACT_ID,
      function: "approve",
      args: [
        new Address(signed.buyer).toScVal(),
        new Address(signed.spender).toScVal(),
        nativeToScVal(BigInt(signed.cap), { type: "i128" }),
        nativeToScVal(signed.allowanceExpirationLedger, { type: "u32" }),
      ],
      auth: [authEntry],
    }),
    "approve",
  );
}

// 2. transfer_from — facilitator auth only (tx source), destination unconstrained.
if (process.env.SKIP_TRANSFER !== "1") {
  await submit(
    Operation.invokeContractFunction({
      contract: TOKEN_CONTRACT_ID,
      function: "transfer_from",
      args: [
        new Address(facilitator.publicKey()).toScVal(),
        new Address(signed.buyer).toScVal(),
        new Address(MERCHANT_ADDRESS).toScVal(),
        nativeToScVal(ACTUAL, { type: "i128" }),
      ],
    }),
    "transfer_from -> merchant",
  );
}

// 3. Trust-gap evidence: with DEMO_TRUST_GAP=1, pull part of the remainder to
// the facilitator's own address. The buyer authorized none of this
// specifically — only the cap.
if (process.env.DEMO_TRUST_GAP === "1") {
  // The only obstacle to pulling funds to itself is a missing USDC trustline,
  // which the facilitator can create for itself in one classic op.
  const account = await server.getAccount(facilitator.publicKey());
  const trustTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
    .setTimeout(120)
    .build();
  trustTx.sign(facilitator);
  const trustSent = await server.sendTransaction(trustTx);
  await server.pollTransaction(trustSent.hash, { attempts: 30 });
  console.log(`changeTrust (facilitator self-serve): ${trustSent.hash}`);

  const grab = (BigInt(signed.cap) - ACTUAL) / 2n;
  await submit(
    Operation.invokeContractFunction({
      contract: TOKEN_CONTRACT_ID,
      function: "transfer_from",
      args: [
        new Address(facilitator.publicKey()).toScVal(),
        new Address(signed.buyer).toScVal(),
        new Address(facilitator.publicKey()).toScVal(),
        nativeToScVal(grab, { type: "i128" }),
      ],
    }),
    "transfer_from -> facilitator (trust-gap demo)",
  );
}
