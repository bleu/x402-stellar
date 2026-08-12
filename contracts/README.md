# upto-settlement — minimal upto Soroban contract

Allowance-proxy `UptoSettlement` contract for STE-60 (started life as experiment 2b). The buyer signs a settlement authorization over everything except the amount; the facilitator supplies the actual amount at settle time. The contract binds the recipient, caps the amount, and enforces a ledger validity window, then pulls only the actual amount to the recipient via the buyer's allowance. No funds are parked, so there is no refund path.

Design aligns with the emerging upstream draft `scheme_upto_stellar.md` (x402-foundation/x402 PR #3134). Not audited; testnet only. See `FINDINGS.md` for results and the comparison memo linked from STE-60. The facilitator wires this contract in through `UptoStellarScheme` (see `examples/facilitator`).

## Build and test

```
cargo test              # 6 unit tests
stellar contract build  # -> target/wasm32v1-none/release/upto_settlement.wasm
```

## Deploy and drive a settle

Deploy with a funded testnet key, then run the driver in `driver/` (needs its own `.env`: `BUYER_SECRET`, `FACILITATOR_SECRET`, `MERCHANT_ADDRESS`, `CONTRACT_ID`, `CAP`, `ACTUAL`):

```
pnpm --filter @x402-stellar/upto-settlement-driver settle
```

The driver simulates `settle`, signs the buyer's auth entry (one entry, covering the nested `approve` too) with `authorizeEntry`, then the facilitator signs the envelope and submits.
