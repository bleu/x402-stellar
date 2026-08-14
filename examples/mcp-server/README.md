# Bazaar MCP server

An [MCP](https://modelcontextprotocol.io/) server that lets an AI agent find a paid API in the x402 Bazaar and pay for it, with no integration written in advance. It exposes two free tools:

- **`search_bazaar`** — queries the facilitator's `GET /discovery/search`. Each result carries the endpoint's price, the parameter names it accepts, and an example call.
- **`paid_request`** — calls an endpoint, and if it answers `402 Payment Required`, signs the payment locally and retries. Returns the response, the settlement transaction, and what is left of the spending budget.

The agent is told one URL: the facilitator. Everything else — which endpoint exists, what it costs, what parameters it takes — it reads out of the catalog at runtime.

## What holds the key

The Stellar secret key is read from this package's own `.env` and stays in this process. The MCP client's config file carries only a command and a working directory, so the config can be shared or shown on screen without leaking anything.

The facilitator never sees the key either. It receives a signed authorization for one transfer — to a fixed recipient, of a fixed asset — and submits it. Non-custodial here is a property of what gets sent, not of the wallet.

With `exact` the amount is fixed too. With `upto` the signature fixes a ceiling and leaves the amount open, which is what lets the seller charge less; the facilitator could still take the whole ceiling whatever the seller asked for. The cap is the protection, so keep caps small and choose facilitators you trust.

What bounds the damage if an agent is talked into spending by injected text (a catalog description and an API response both land in the model's context, and both are written by someone else):

- `MAX_PAYMENT` caps one call; `SESSION_BUDGET` caps the process's whole lifetime.
- `PAYABLE_ASSETS` is an allowlist, and only the `exact` and `upto` schemes are signable. A 402 asking for anything else is refused before signing, so a hostile server cannot get a signature for a token we cannot value or a mechanism we did not audit.
- An `upto` price is checked against `MAX_PAYMENT` and the session budget at its ceiling, not at some hoped-for charge, so the caps bound the worst case rather than the advertised one.
- Payment headers cannot be supplied by the caller, so the agent cannot forge one.
- The MCP client asks the human to approve each tool call, which is where the URL and arguments become visible.

Deliberately absent: any restriction of `paid_request` to catalogued URLs. Cataloging is settlement-observed — a resource enters the catalog only after someone pays it — so a catalog gate would mean nothing new could ever be discovered through this server.

## Setup

```bash
cp .env.example .env      # add STELLAR_PRIVATE_KEY
pnpm install
pnpm build
```

The buyer account needs a testnet USDC trustline and a balance. `examples/client-cli/.env` already holds a funded throwaway key for this.

Bring the rest of the stack up **in this order**, from the repository root:

```bash
cd examples/facilitator && docker compose up -d && cd -   # pgvector Postgres
pnpm --filter @x402-stellar/facilitator dev               # wait for /health
pnpm --filter @x402-stellar/facilitator seed-catalog       # 20 synthetic rows
pnpm --filter @x402-stellar/simple-paywall-server dev     # the paid endpoint
```

The order is not cosmetic. The paywall server validates its facilitator at boot and exits if it cannot reach one, so starting it first leaves you with a dead process and a confusing `fetch failed` in its log.

### Prime the catalog before you demo

Seeding fills the catalog with twenty synthetic services. It does **not** put the local paid endpoint in there, because cataloging is settlement-observed: a resource appears only after someone pays it. On a fresh database the agent's first search cannot find the endpoint at all.

So pay it once, with any client:

```bash
SERVER_URL=http://localhost:3001 pnpm --filter @x402-stellar/client-cli dev
```

After that the endpoint is in the catalog and ranks first for a weather query, and the agent's own payment increments its usage counters. No registration step exists — this is the mechanism working as designed, not a workaround.

## Wiring it into an agent

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-bazaar": {
      "command": "node",
      "args": ["/absolute/path/to/examples/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/examples/mcp-server"
    }
  }
}
```

Claude Code, in `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "x402-bazaar": {
      "command": "pnpm",
      "args": ["--filter", "@x402-stellar/mcp-server", "dev"]
    }
  }
}
```

`cwd` matters: `.env` is loaded relative to it. Neither config contains a secret.

## Rehearsing without an agent

```bash
pnpm demo "current weather for a city" --max-usd 0.01
```

Runs the same server and the same tools over an in-memory transport, so a failure can be reproduced in one command instead of by re-prompting a model. It searches, pays the top payable result using the example values the catalog declared, searches again to print the row's usage signals before and after, then calls once more so the session budget refuses — every beat of the recording, in order. `--refuse` shrinks the caps to nothing so the first call is rejected too.

`--scheme upto` picks a ceiling-priced row instead of the first payable one, and prints the ceiling against the charge. Search still lists both rows either way, so the choice stays visible. On that path the closing refusal may not fire, because reconciling the first call gives budget back; `--refuse` still rehearses the refusal on its own.

For the refusal to land on the second call, `SESSION_BUDGET` has to leave room for exactly one payment. With the endpoint at `0.001`, use:

```bash
MAX_PAYMENT=0.01
SESSION_BUDGET=0.0015
```

A limit the _user_ states in a prompt is not this budget: the agent passes that to `search_bazaar` as `maxUsdPrice`, which filters the catalog. Asking for something absurdly cheap therefore produces an empty search, not a payment refusal, so it does not exercise the rejection path.

## Reading a result

A successful `paid_request`:

```json
{
  "url": "http://localhost:3001/weather/testnet?city=San+Francisco",
  "status": 200,
  "body": { "city": "San Francisco", "current": { "temperature_f": 63.4 } },
  "paid": true,
  "settlement": {
    "success": true,
    "transaction": "abc123...",
    "network": "stellar:testnet",
    "amountAtomic": "10000",
    "usd": "0.001",
    "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123..."
  },
  "budget": { "sessionLimit": "0.05", "spent": "0.001", "remaining": "0.049" }
}
```

A ceiling-priced endpoint reports both numbers, because the reserve and the release both happen inside the one call:

```json
{
  "settlement": {
    "success": true,
    "amountAtomic": "10000",
    "usd": "0.001",
    "reservedAtomic": "30000",
    "reservedUsd": "0.003"
  },
  "budget": { "sessionLimit": "0.05", "spent": "0.001", "remaining": "0.049" }
}
```

`reservedAtomic` and `reservedUsd` are absent when the two are the same number: always for `exact`, and for an `upto` that took its whole ceiling.

Every failure carries a code from a closed set and a reason that is never null:

```json
{
  "error": {
    "code": "cap_exceeded",
    "reason": "Payment of 0.02 exceeds the per-call limit of 0.01",
    "details": { "quote": { "amountAtomic": "200000", "usd": "0.02" } }
  }
}
```

Codes this server raises itself: `cap_exceeded`, `session_budget_exhausted`, `asset_not_allowed`, `network_not_supported`, `scheme_not_supported`, `invalid_url`, `forbidden_header`, `no_acceptable_payment_option`. Codes for a failure further down: `payment_required_malformed`, `verify_failed`, `settle_failed`, `settle_indeterminate`, `upstream_error`, `transport_error`. Discovery's: `search_unavailable`, `search_failed`. Anything unforeseen becomes `internal_error`.

`network_not_supported` and `scheme_not_supported` are separate on purpose. The x402 client raises one message for both, so this server reads the 402's own `accepts` list to see which it really was — an endpoint charging in a scheme we hold no client for, on a network we do support, is a scheme problem, and saying otherwise would send the agent looking in the wrong place.

When the failure came from the facilitator or the resource server, its own `invalidReason` or `errorReason` appears in `details` word for word. Our code says which stage failed; theirs says why.

## Two behaviours worth knowing before you trust the numbers

**Budget is charged at signing, and given back only on certainty.** A payment we signed and sent may settle even when the answer never reaches us — `@x402/core` says as much about a settle timeout. So the allowance is consumed the moment a payment is signed, and a payment that genuinely failed still costs one call's worth of budget. `settle_indeterminate` is the code for that case, and it is deliberately not a flavour of `settle_failed`. The alternative — crediting only confirmed successes — would let repeated timeouts spend past the ceiling while every individual check passed.

With `upto` what gets signed is a ceiling, so the ceiling is what gets charged: it is all the signature bounds, and the seller has not chosen yet. When the answer comes back saying it succeeded and naming the amount, the charge comes down to that amount and the difference returns to the session budget. A failure, a timeout, or a settlement that names no amount all keep the ceiling charged. Without the release, a one-cent ceiling that charges a tenth of a cent would drain a session budget many times over.

One case is worse than it looks. When the endpoint answers 4xx it cancels the payment, so nothing settles on-chain — but the response carries no settlement to reconcile against, so the wallet keeps the whole ceiling charged for a call that cost nothing. Asking a weather endpoint for a city that does not exist therefore spends budget without spending money. `@x402/core` gives the resource server a cancellation hook but the client no signal it can trust, and guessing from "4xx and no settlement header" would hand free allowance to anything that strips headers. Keeping the charge is the same conservative choice as a timeout.

**The budget resets when the process restarts.** It lives in memory, keyed to nothing. Restart the server and the session starts again with a full allowance.

## Ranking does not use usage

Search results carry a `quality` block (`l30DaysTotalCalls`, `l30DaysUniquePayers`, `lastCalledAt`), and the ranking ignores it. The seeded catalog is synthetic, so the one endpoint anyone has actually paid would win every query on a usage boost, and that would demonstrate a popularity counter rather than search. The numbers are shown, not scored.

## Tool descriptions name no services

The descriptions explain parameters and the payment protocol and nothing else — no service, no domain, no subject area. Stating that `maxUsdPrice` is in US dollars is documentation; naming a kind of API to look for would be pre-baking the demo. A test greps the descriptions for the seed corpus's service names and demo hostnames and fails the build if any appear.

## Environment

| Variable              | Default                 | Meaning                                                |
| --------------------- | ----------------------- | ------------------------------------------------------ |
| `STELLAR_PRIVATE_KEY` | required                | The buyer's secret key. Never leaves this process      |
| `STELLAR_NETWORK`     | `stellar:testnet`       | CAIP-2 network id                                      |
| `STELLAR_RPC_URL`     | testnet Soroban RPC     | Simulates the settle an `upto` ceiling authorizes      |
| `FACILITATOR_URL`     | `http://localhost:4022` | The Bazaar to search                                   |
| `MAX_PAYMENT`         | `0.01`                  | Most one call may spend, in whole tokens               |
| `SESSION_BUDGET`      | `0.05`                  | Most this process may spend, in whole tokens           |
| `PAYABLE_ASSETS`      | testnet USDC            | `network\|contract\|decimals\|symbol`, comma separated |
| `LOG_LEVEL`           | `info`                  | Logs go to stderr; stdout is the JSON-RPC stream       |

## Not built

An MCP tool that is itself paid, which `@x402/mcp` supports, needs an x402-aware MCP client. Claude Desktop and Claude Code are not, so only our own code could pay such a tool.

A signer in a separate process — so the process the model talks to could not sign at all — is the shape to reach for in production; here the key sits in the same process.
