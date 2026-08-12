# Experiment 2b findings — minimal upto Soroban contract

Run 2026-08-12, Stellar testnet. Allowance-proxy design (our grilling choice), aligned with the emerging upstream draft `scheme_upto_stellar.md` (x402-foundation/x402 PR #3134).

## What was built

A single-function `UptoSettlement` contract (`contracts/upto-settlement/src/lib.rs`). `settle` takes the buyer, recipient, asset, cap, validity window (ledger bounds), allowance expiration ledger, a salt, and the actual amount. The buyer authorizes every argument except the amount via `require_auth_for_args`; the facilitator supplies the amount at call time. The contract checks `0 <= amount <= cap` and the ledger window, then grants itself the buyer's allowance up to the cap and pulls only the actual amount to the bound recipient. Nothing is parked in the contract, so there is no refund path — an unused allowance simply expires.

Wasm: 2190 bytes optimized, one exported function.

## Evidence

- Unit tests (6, all green): settle-below-cap leaves the remainder with the buyer, full-cap settlement, and rejections for amount-above-cap, negative amount, before-valid-after, and after-deadline. Run with `cargo test`.
- Deployed to testnet: contract `CARIDBM7FJQHMHJVAWNAUG5IF5FXOLWBYGHLHMQBIX7MPN5BSPJHDR43`, deploy tx `2ccfdb13…`.
- One real settle driven through it: tx `72d33ecf0a2bdffc0a280ef159154b7a96ac7edb36b9f3c668f85e0e2875fbdb`, cap 1 USDC, settled 0.3 USDC to the merchant.

## Answered: one signature covers settle + approve

The grilling left open whether a single buyer auth entry could cover both the top-level `settle` (amount excluded) and the nested `token.approve` sub-invocation. It can. Simulation shows the buyer's auth entry with `approve` as sub-invocation #0, and the driver signs exactly one entry with `authorizeEntry`. So the buyer signs once, `exact`-style — no separate approve step, unlike the contract-free 2a flow which needs a distinct signed `approve`.

## Trust model vs 2a

The contract closes the 2a gap on-chain: recipient is bound (`pay_to` is inside the signed args, so redirection breaks the signature), the amount cannot exceed the signed cap, and the authorization is single-use via Soroban's own auth-entry nonce — so the contract keeps no nonce storage of its own (confirmed against the 2a finding that a replayed auth entry fails with `Auth, ExistingValue`). The buyer now trusts only the server's metering within the cap, matching the EVM and SVM upto trust bar.

## Effort (agent-written — read the caveat)

Written by the agent, not a human, so this does NOT measure the "Rust risk for a human team" the issue asked for; that must be estimated separately. As an agent data point: scaffold via `stellar contract init`, ~120 lines of contract, 6 tests, deploy, and a TS driver, in one session. One real bug (a `BytesN` built from the wrong `Env` in tests → "mis-tagged object reference"). The only friction against the plan's "settle via CLI" idea was multi-party auth signing (facilitator source + buyer auth entry) — the CLI path fought interactive-confirmation and custom-config-dir issues, so the driver signs the buyer auth entry explicitly with the SDK, the same approach 2a already used.
