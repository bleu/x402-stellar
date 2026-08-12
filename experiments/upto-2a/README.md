# Experiment 2a — contract-free upto via SEP-41 allowances

Standalone scripts for STE-60. They test whether the x402 `upto` scheme can run on Stellar without a Soroban contract: the buyer signs one offline auth entry for `approve` (facilitator as spender, cap as amount), and the facilitator settles the actual amount with `transfer_from`.

This is an experiment, not a product. See the comparison memo linked from STE-60 for the trust-model analysis and the recommendation.

## Run

Create `.env` in this directory:

```
BUYER_SECRET=S...          # buyer testnet key
FACILITATOR_SECRET=S...    # facilitator testnet key (the spender)
MERCHANT_ADDRESS=G...      # payment destination
CAP=10000000               # 1 USDC (7 decimals)
ACTUAL=3000000             # 0.3 USDC
```

Then:

```
pnpm sign     # buyer role: writes signed-approve.json (offline signature, no tx)
pnpm settle   # facilitator role: submits approve, then transfer_from to merchant
```

`DEMO_TRUST_GAP=1 pnpm settle` also pulls part of the unspent allowance to the facilitator's own address — on-chain proof that nothing binds the destination or the amount below the cap.
