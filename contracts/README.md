# upto-settlement — minimal upto Soroban contract

Allowance-proxy `UptoSettlement` contract for the x402 `upto` scheme. The buyer signs a settlement authorization over everything except the amount; the facilitator supplies the actual amount at settle time. The contract binds the recipient, caps the amount, and enforces a ledger validity window, then pulls only the actual amount to the recipient via the buyer's allowance. No funds are parked, so there is no refund path.

Design aligns with the emerging upstream draft `scheme_upto_stellar.md` (x402-foundation/x402 PR #3134). Not audited; testnet only. The facilitator wires this contract in through `UptoStellarScheme` (see `examples/facilitator`).

Integration note: clients driving this contract must pin `@stellar/stellar-sdk` to v14.6 to match `@x402/stellar` — the v15 XDR parser mis-reads simulation auth entries ("unknown SorobanCredentialsType member for value 2").

## Build and test

```
cargo test              # unit tests
stellar contract build  # -> target/wasm32v1-none/release/upto_settlement.wasm
```

## Deploy and drive a settle

Deploy with a funded testnet key, set `UPTO_CONTRACT_ID`, then run the facilitator's end-to-end script, which builds the buyer payload offline, verifies it, and settles a partial amount through `UptoStellarScheme`:

```
cd examples/facilitator
pnpm exec tsx --env-file=.env scripts/upto-e2e.ts
```
