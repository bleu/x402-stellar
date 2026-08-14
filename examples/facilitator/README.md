# Stellar Facilitator

Express service that verifies and settles [x402](https://www.x402.org/) payments on the Stellar network. A paywall server forwards payment headers here; the facilitator checks the transaction is valid and submits it on-chain.

The service is one process composed of three modules under `src/modules/`:

- **facilitator** — the x402 protocol endpoints (`/verify`, `/settle`, `/supported`), a thin shell over `@x402/stellar`'s `ExactStellarScheme`, which owns all payload validation and settlement machinery. When `UPTO_CONTRACT_ID` is set, it also registers `UptoStellarScheme` from `@x402-stellar/upto/facilitator`, which serves the `upto` scheme — partial settlement up to a buyer-signed cap — through the `UptoSettlement` contract in `contracts/`. `scripts/upto-e2e.ts` drives one verify-then-settle through it on testnet.
- **catalog** — optional resource discovery backed by Postgres with pgvector. When `DATABASE_URL` is set, resources seen in successful settlements are recorded (via the facilitator's after-settle hook) and served at `GET /discovery/resources` and `GET /discovery/search` in the [x402 Bazaar](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md) shapes. Without `DATABASE_URL` the module is disabled and the facilitator runs fully stateless.
- **prices** — optional USD rates for the `maxUsdPrice` search filter, polled from CoinGecko.

## Endpoints

| Method | Path                   | Description                                     |
| ------ | ---------------------- | ----------------------------------------------- |
| POST   | `/verify`              | Validate a payment payload                      |
| POST   | `/settle`              | Submit the transaction to the network           |
| GET    | `/supported`           | List supported scheme/network pairs             |
| GET    | `/discovery/resources` | List cataloged resources (needs `DATABASE_URL`) |
| GET    | `/discovery/search`    | Hybrid natural-language search over the catalog |
| GET    | `/health`              | Health check                                    |

Both `/discovery` endpoints are deliberately public so Bazaar clients can browse without an API key; they are still rate-limited.

## The upto scheme

Set `UPTO_CONTRACT_ID` and the facilitator serves a second scheme, where the buyer signs a ceiling and the seller charges at or below it.

Verify and settle answer different questions, which is the whole of it:

- **Verify** runs before the handler, so `requirements.amount` is still the quoted ceiling. It asserts that ceiling equals the `maxAmount` the buyer signed. That is what stops a seller quoting one number and collecting a signature for another.
- **Settle** runs after, with the amount the seller chose already written into `requirements.amount`. It accepts anything from zero up to the signed ceiling, settles that number, and returns it in the settle response.

`/supported` advertises two addresses in `extra` for this scheme: `contract`, the `UptoSettlement` instance, and `settler`, the account that submits the settle. A buyer needs both to build its authorization, and gets them from the 402 rather than from anything agreed out of band. The buyer must simulate against `settler`; simulating as itself collapses the authorization into a source-account credential and leaves nothing detached to sign offline.

Core does not clamp a settlement override — `resolveSettlementOverrideAmount` passes a raw number straight through — so the range check in settle and the contract are the only guards against a seller asking for more than the ceiling.

A resource server priced this way registers `UptoStellarServerScheme` from `@x402-stellar/upto/server` and sets the amount with `setSettlementOverrides` from `@x402/express`. `examples/simple-paywall` does exactly that on `GET /weather-upto/:network`: it quotes a 0.003 ceiling, then charges the whole ceiling for a short premium city list and a third of it for anything else. A 4xx from that handler cancels the payment and drops the override, so a city it could not resolve costs the buyer nothing.

## Cataloging

A resource is cataloged only when the payer's `PaymentPayload` carries a `bazaar` discovery extension. Everything else settles normally and is not recorded — there is no separate registration step, and nothing requires the seller to act after payment.

Validation is `@x402/extensions/bazaar`'s own `extractDiscoveryInfo`, so route-template checks (percent-decoding, `..` and `://`), the service-metadata soft-drop rules (32-character `serviceName`, at most 5 tags, http(s) non-loopback `iconUrl`), JSON-Schema validation of `info`, and MCP tool-name extraction all behave exactly as the spec's reference implementation does.

Two consequences worth knowing:

A resource is keyed by `origin + (routeTemplate ?? pathname)`, so query strings never create duplicate rows and `/weather/testnet` is stored once as `/weather/:network`. Row identity is `(resource, toolName)`, which lets several MCP tools share one endpoint without overwriting each other.

`accepts` reflects the payment options actually observed in settlements, not the full set a server declares. The facilitator only ever sees the one option a client chose (`PaymentPayload.accepted`); `PaymentRequired.accepts` never reaches it. So an option a server has stopped offering lingers until it ages out of relevance, and the `asset`, `maxAmount` and `maxUsdPrice` filters judge observed prices rather than declared ones.

Each settlement also appends a row to `catalog_settlements` holding the resource, asset, and **payer address**. Payer addresses are public chain data and are the only way to count distinct payers; they drive the `quality` block on search results (`l30DaysTotalCalls`, `l30DaysUniquePayers`, `lastCalledAt`).

## Search

`GET /discovery/search?query=...` ranks the catalog by reciprocal rank fusion over two arms: Postgres full-text search over a stored text document, and cosine distance over local [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) embeddings in pgvector. Each arm applies every filter and takes its own top 50; the two are fused with `1/(60 + rank)`. No API key and no outbound calls: the model runs in-process via `@huggingface/transformers`.

| Parameter        | Applies to | Description                                                     |
| ---------------- | ---------- | --------------------------------------------------------------- |
| `query`          | search     | Natural-language query (required)                               |
| `type`           | both       | Protocol type, `http` or `mcp`                                  |
| `payTo`          | both       | Payment recipient address                                       |
| `scheme`         | both       | Payment scheme                                                  |
| `network`        | both       | CAIP-2 network identifier                                       |
| `extensions`     | both       | Extension key that must be present, e.g. `bazaar`               |
| `asset`          | both       | Comma-separated asset list, matched as any-of                   |
| `maxAmount`      | both       | Atomic units; needs exactly one `asset` or the request is a 400 |
| `maxUsdPrice`    | both       | USD ceiling across assets with a known rate                     |
| `tags`           | both       | Comma-separated tag list, matched as any-of                     |
| `urlSubstring`   | both       | Case-insensitive substring of the resource url                  |
| `limit`          | search     | Defaults to 10, capped at 20                                    |
| `limit`/`offset` | resources  | Defaults to 100, capped at 1000                                 |

Search answers `{x402Version, resources, searchMethod, partialResults?, warnings?}`. Note the array is `resources` here and `items` on the list route — that difference is in the SDK's types, not an inconsistency here. `partialResults` appears when matches were truncated.

A price ceiling never silently hides anything. Resources priced only in assets with no USD rate are kept, and `warnings` says how many escaped the check; if no rate is available at all, `warnings` says the filter was not applied rather than blaming the assets.

Natural language stays in `query`. A price constraint arrives as `maxUsdPrice`, which is what the reference Bazaar does — translating "under a cent" into `maxUsdPrice=0.01` is the calling agent's job.

### Demo corpus

`pnpm seed-catalog` loads twenty synthetic services alongside whatever real settlements have recorded. They are built as real `PaymentPayload` objects and pushed through the same extraction and upsert path a settlement uses, so a seeded row cannot have a shape real traffic could not produce. Seeded rows carry `source = 'seed'`, which is stored but never served.

The corpus is designed to exercise each branch rather than to look realistic: several rival weather services (one pricier than a cent, one with a thin description, one with no `serviceName`), a spread of assets including one with no USD mapping, a templated route, an MCP tool, and entries that trip the soft-drop rules.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your Stellar secret key
pnpm dev
```

The facilitator listens on port 4022 by default.

## Configuration

| Variable                              | Default                          | Description                                   |
| ------------------------------------- | -------------------------------- | --------------------------------------------- |
| `FACILITATOR_STELLAR_PRIVATE_KEY`     | _required_                       | Stellar secret key for single-signer mode     |
| `PORT`                                | `4022`                           | Listen port                                   |
| `STELLAR_NETWORK`                     | `stellar:testnet`                | CAIP-2 network identifier                     |
| `STELLAR_RPC_URL`                     | testnet RPC                      | Custom Soroban RPC URL (required for pubnet)  |
| `LOG_LEVEL`                           | `info`                           | Pino log level                                |
| `CORS_ORIGINS`                        | `*`                              | Comma-separated allowed origins               |
| `TRUST_PROXY`                         | `loopback,linklocal,uniquelocal` | Trusted proxy ranges                          |
| `MAX_TRANSACTION_FEE_STROOPS`         | `50000` (library default)        | Max fee in stroops accepted from clients      |
| `FACILITATOR_STELLAR_FEE_BUMP_SECRET` | --                               | Fee-bump signer secret (high-throughput)      |
| `FACILITATOR_STELLAR_CHANNEL_SECRETS` | --                               | Channel account secrets, comma-separated      |
| `DATABASE_URL`                        | --                               | Postgres URL; enables the catalog module      |
| `COINGECKO_API_KEY`                   | --                               | Demo key; enables USD rates for `maxUsdPrice` |

A local pgvector-enabled Postgres for the catalog module ships in `docker-compose.yml`:

```bash
docker compose up -d postgres
# then in .env:
# DATABASE_URL=postgres://facilitator:facilitator@localhost:5442/facilitator
pnpm seed-catalog   # optional: load the twenty synthetic demo services
```

The schema is created automatically at startup. `DATABASE_URL` must point at a Postgres with pgvector available (the image is `pgvector/pgvector:pg17`); the facilitator creates the extension itself and fails at startup if it cannot, rather than degrading to a search that silently returns nothing.

The schema is create-if-absent with no migration handling, which is fine pre-production but means **adding a column requires recreating the volume**:

```bash
docker compose down -v && docker compose up -d postgres
```

The MiniLM weights are loaded at startup, so a missing model fails at boot rather than on the first query. The Docker image bakes them in, so the running container needs no HuggingFace egress.

The mapped USDC contracts are assumed to be worth a dollar, so `maxUsdPrice` filters with no API key and no network at all. That assumption is what makes the filter usable on testnet: CoinGecko indexes Stellar mainnet contracts but not testnet ones, so the asset the demo charges in could never be quoted. A live quote is never applied to a pegged asset, which keeps demo prices from wandering. Assets with no assumed peg, such as XLM, need `COINGECKO_API_KEY`, and until a rate arrives a resource priced only in them is kept and counted in `warnings` rather than judged.

With a key, prices are polled every 15 minutes in one batched call — roughly 2,880 calls a month against the demo tier's 10,000 — and a price older than an hour stops being trusted. The poll runs without a key too, rewriting the assumed rates so they never age out. The asset-to-CoinGecko map is maintained by hand in `src/modules/prices/index.ts`. `PaymentRequirements` carries no decimals field, so USD conversion assumes the `@x402/stellar` default of 7 decimals for mapped assets.

## Operating Modes

### Single-signer (default)

Set `FACILITATOR_STELLAR_PRIVATE_KEY` and nothing else. The facilitator uses one account for both sequence numbers and fee payment. Simple, but limited to one in-flight transaction at a time.

### High-throughput with channel accounts (recommended)

On Stellar, each transaction increments the source account's sequence number, so a single account can only have one transaction in-flight at a time. Channel accounts solve this: each one manages its own sequence number, and a separate fee-bump signer pays all fees. With _N_ channel accounts the facilitator can submit up to _N_ transactions in parallel.

When both `FACILITATOR_STELLAR_FEE_BUMP_SECRET` and `FACILITATOR_STELLAR_CHANNEL_SECRETS` are set, the facilitator automatically switches to this mode. The `ExactStellarScheme` uses round-robin to select which channel account signs each inner transaction, then wraps it in a fee-bump transaction signed by the fee-bump account.

#### Generating channel accounts

A bundled script creates 1 fee-payer account + 19 channel accounts on testnet in a single transaction:

```bash
pnpm generate-channel-accounts
```

This will:

1. Create a fee-payer keypair and fund it via Friendbot
2. Generate 19 channel account keypairs
3. Create all 19 accounts on-chain with **zero balance** using sponsored reserves (`BeginSponsoringFutureReserves` + `CreateAccount` + `EndSponsoringFutureReserves`)
4. Submit the transaction and wait for confirmation
5. Save all keys to a timestamped `.env` file in `scripts/output/`
6. Print the two environment variables to add to `.env`

Example output:

```
=== Environment Variables ===

FACILITATOR_STELLAR_FEE_BUMP_SECRET=SABC...
FACILITATOR_STELLAR_CHANNEL_SECRETS=S1...,S2...,S3...,...,S19...

Copy these into your .env file.
```

Paste those lines into your `.env` and restart:

```bash
pnpm dev
```

You should see:

```
INFO: High-throughput mode: fee-bump signer + channel accounts
  feeBumpAddress: "G..."
  channelCount: 19
```

When the channel account variables are absent or empty, the facilitator falls back to single-signer mode -- no changes needed.

## Utility Scripts

| Script                             | Description                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm seed-catalog`                | Load the twenty synthetic demo services into the catalog (needs `DATABASE_URL`)       |
| `pnpm generate-channel-accounts`   | Create 1 fee-payer + 19 channel accounts on testnet (saves keys to `scripts/output/`) |
| `pnpm refund-accounts-from-env`    | Re-fund facilitator accounts from `.env` secrets after a testnet reset                |
| `pnpm refund-accounts-from-remote` | Fund signer addresses fetched from a remote facilitator's `/supported` endpoint       |

After a testnet reset all accounts are wiped. The refund scripts call Friendbot to re-activate existing accounts — they do **not** re-create sponsored-reserve relationships. Each account receives 10,000 XLM independently.

## Development

```bash
pnpm dev          # Run with tsx watch (auto-reloads on file changes)
pnpm build        # Compile to dist/ with tsup
pnpm start        # Run compiled output (dist/index.js)
pnpm test         # Run tests
pnpm typecheck    # Type-check without emitting
pnpm lint         # Lint src/
```

### Catalog tests

The catalog's ranking is almost entirely SQL — generated tsvector columns, HNSW ranking, rank fusion — which no stub can stand in for. Those tests run against a real pgvector Postgres and are skipped unless `CATALOG_TEST_DATABASE_URL` is set, so `pnpm test` stays fast and needs neither a database nor the model:

```bash
docker compose up -d postgres
CATALOG_TEST_DATABASE_URL=postgres://facilitator:facilitator@localhost:5442/facilitator pnpm test
```

That also switches on the MiniLM embedder tests and a golden-query evaluation over the demo corpus. The golden answers are ours, so the evaluation measures regression rather than absolute quality: it catches a change that made ranking worse than it was and says nothing about how the ranking compares to any other system.

These tests own the schema of the database they point at (they drop and recreate the catalog tables), so point them at a scratch database rather than one holding anything you want to keep. They currently run locally only; wiring them into CI is deliberately left for a follow-up.
