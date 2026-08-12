# Experiment 2a findings — contract-free upto on testnet

Run 2026-08-12, Stellar testnet, Circle USDC SAC (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`).

Accounts: buyer `GCRXEB4B…`, facilitator/spender `GBOV6UQV…`, merchant `GAZNKV4O…`. Cap 1 USDC, actual 0.3 USDC.

## What worked

1. **Offline signing.** The buyer signs the `approve` auth entry with `authorizeInvocation` and never touches the network beyond reading the ledger number. Output is a base64 auth entry; no transaction is built or submitted by the buyer. This is the same offline-signature shape the `exact` scheme already uses.
2. **Facilitator settlement.** With the facilitator as the transaction source, `approve` (carrying the buyer's auth entry) then `transfer_from` for the actual amount both land:
   - approve: `e12042c4e41fad1eca2c72fe6ee4e714557532c9253432c38b969c2cb873c42f`
   - transfer_from → merchant: `fb771233c73e974842e3602611ffc8e8a47e0a88e8cd36066875dee5393d5cce`

## Trust-model facts, confirmed on-chain

3. **The signed authorization is single-use.** Re-submitting the same signed `approve` fails at simulation with `Error(Auth, ExistingValue)` — the Soroban auth-entry nonce is consumed. So the *authorization* cannot be replayed, even though the resulting allowance is not itself single-use.
4. **The allowance is not recipient-bound and not single-settlement.** After settling 0.3 USDC to the merchant, the facilitator pulled part of the unspent remainder to its own address, authorized only by its own signature — the buyer signed none of this specifically, only the cap. The facilitator created its own USDC trustline first (one classic op, no buyer involvement):
   - changeTrust (facilitator self-serve): `cc34402c423228467fefadabd184b3b0019a272a7be43146e0ac4f53cf4ed099`
   - transfer_from → facilitator: `8de5288f455c24f52d0c9a8c8e83d92570b6f12b87b46717bb386b1e927b8c15`

## Precise trust gap (corrects the STE-60 issue text)

The exposure is **"full cap, once, to any destination the facilitator chooses, ignoring actual usage and the merchant"** — not "pull more than once before expiry." SEP-41 allowances are absolute (`approve` sets, `transfer_from` decrements) and the signed auth entry's nonce blocks replay of the *authorization*, but nothing on-chain binds the destination or forces the settled amount to match real usage. Under an open-facilitator model (buyers cannot rely on operator reputation), this is custody-grade trust in an arbitrary third party.

Effort: the scripts are ~180 lines total and worked on the first testnet run after one fix (facilitator needed its own trustline to receive USDC — itself part of the trust-gap evidence). No contract, no Rust.
