import "dotenv/config";
import {
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

// Facilitator-side driver for the 2b UptoSettlement contract. The buyer signs
// only the settle authorization (everything but the amount); the facilitator
// picks the actual amount and submits. The buyer's single signed auth entry
// also covers the nested token.approve sub-invocation.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const buyer = Keypair.fromSecret(req("BUYER_SECRET"));
const facilitator = Keypair.fromSecret(req("FACILITATOR_SECRET"));
const contractId = req("CONTRACT_ID");
const merchant = req("MERCHANT_ADDRESS");

const asset = new Asset(
  process.env.ASSET_CODE ?? "USDC",
  process.env.ASSET_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);
const tokenId = asset.contractId(PASSPHRASE);

const maxAmount = BigInt(process.env.CAP ?? 1_000_000);
const amount = BigInt(process.env.ACTUAL ?? 300_000);

const server = new rpc.Server(RPC_URL);
const { sequence: ledger } = await server.getLatestLedger();
const validAfterLedger = 0;
const deadlineLedger = ledger + 100_000;
const expirationLedger = ledger + 17_280;
const authValidUntil = ledger + 720;
const salt = Buffer.alloc(32, 7);

function u32(n: number) {
  return nativeToScVal(n, { type: "u32" });
}
function i128(n: bigint) {
  return nativeToScVal(n, { type: "i128" });
}

const settleArgs = [
  new Address(buyer.publicKey()).toScVal(),
  new Address(merchant).toScVal(),
  new Address(tokenId).toScVal(),
  i128(maxAmount),
  u32(validAfterLedger),
  u32(deadlineLedger),
  u32(expirationLedger),
  nativeToScVal(salt, { type: "bytes" }),
  i128(amount),
];

const account = await server.getAccount(facilitator.publicKey());
const tx = new TransactionBuilder(account, {
  fee: (Number(BASE_FEE) * 100).toString(),
  networkPassphrase: PASSPHRASE,
})
  .addOperation(
    Operation.invokeContractFunction({
      contract: contractId,
      function: "settle",
      args: settleArgs,
    }),
  )
  .setTimeout(120)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);

// Sign every auth entry that carries address credentials (the buyer's); leave
// source-account credentials for the envelope signature.
const rawAuth = sim.result?.auth ?? [];
const signedAuth = await Promise.all(
  rawAuth.map((entry) => {
    if (
      entry.credentials().switch() ===
      xdr.SorobanCredentialsType.sorobanCredentialsAddress()
    ) {
      return authorizeEntry(entry, buyer, authValidUntil, PASSPHRASE);
    }
    return entry;
  }),
);

const rebuilt = TransactionBuilder.cloneFrom(tx)
  .clearOperations()
  .addOperation(
    Operation.invokeContractFunction({
      contract: contractId,
      function: "settle",
      args: settleArgs,
      auth: signedAuth,
    }),
  )
  .build();

const prepared = rpc.assembleTransaction(rebuilt, sim).build();
prepared.sign(facilitator);

const sent = await server.sendTransaction(prepared);
if (sent.status === "ERROR") {
  throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
}
const result = await server.pollTransaction(sent.hash, { attempts: 30 });
if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
  throw new Error(`settle failed on-chain: ${result.status}`);
}
console.log(`settle: ${sent.hash}`);
console.log(`  cap ${maxAmount}, settled ${amount}, pay_to ${merchant}`);
