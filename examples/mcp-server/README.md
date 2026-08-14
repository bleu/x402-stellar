# Bazaar MCP server

An [MCP](https://modelcontextprotocol.io/) server that lets an AI agent find a paid API in the x402 Bazaar and pay for it, with no integration written in advance. It exposes two free tools:

- **`search_bazaar`** — queries the facilitator's `GET /discovery/search`. Each result carries the endpoint's price, the parameter names it accepts, and an example call.
- **`paid_request`** — calls an endpoint, and if it answers `402 Payment Required`, signs the payment locally and retries. Returns the response, the settlement transaction, and what is left of the spending budget.

The agent is told one URL: the facilitator. Everything else — which endpoint exists, what it costs, what parameters it takes — it reads out of the catalog at runtime.

## What holds the key

The Stellar secret key is read from this package's own `.env` and stays in this process. The MCP client's config file carries only a command and a working directory, so the config can be shared or shown on screen without leaking anything.

The facilitator never sees the key either. It receives a signed authorization for one exact transfer — a fixed amount, to a fixed recipient, of a fixed asset — and submits it. Non-custodial here is a property of what gets sent, not of the wallet.

What bounds the damage if an agent is talked into spending by injected text (a catalog description and an API response both land in the model's context, and both are written by someone else):

- `MAX_PAYMENT` caps one call; `SESSION_BUDGET` caps the process's whole lifetime.
- `PAYABLE_ASSETS` is an allowlist. A 402 asking for anything else is refused before signing, so a hostile server cannot get a signature for a token we cannot value.
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

Needs, on localhost:

- the facilitator with its catalog enabled (`DATABASE_URL` set, seeded with `pnpm --filter @x402-stellar/facilitator seed-catalog`)
- the `simple-paywall` server, which serves the paid endpoint the catalog knows about

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

Runs the same server and the same tools over an in-memory transport, so a failure can be reproduced in one command instead of by re-prompting a model. It searches, pays the top payable result using the example values the catalog declared, then searches again and prints the row's usage signals before and after. `--refuse` forces the spending cap to reject, which rehearses the structured-error path.

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

Codes this server raises itself: `cap_exceeded`, `session_budget_exhausted`, `asset_not_allowed`, `network_not_supported`, `invalid_url`, `forbidden_header`, `no_acceptable_payment_option`. Codes for a failure further down: `payment_required_malformed`, `verify_failed`, `settle_failed`, `settle_indeterminate`, `upstream_error`, `transport_error`. Discovery's: `search_unavailable`, `search_failed`. Anything unforeseen becomes `internal_error`.

When the failure came from the facilitator or the resource server, its own `invalidReason` or `errorReason` appears in `details` word for word. Our code says which stage failed; theirs says why.

## Two behaviours worth knowing before you trust the numbers

**Budget is charged at signing, not at success.** A payment we signed and sent may settle even when the answer never reaches us — `@x402/core` says as much about a settle timeout. So the allowance is consumed the moment a payment is signed and is never given back, and a payment that genuinely failed still costs one call's worth of budget. `settle_indeterminate` is the code for that case, and it is deliberately not a flavour of `settle_failed`. The alternative — crediting only confirmed successes — would let repeated timeouts spend past the ceiling while every individual check passed.

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
| `FACILITATOR_URL`     | `http://localhost:4022` | The Bazaar to search                                   |
| `MAX_PAYMENT`         | `0.01`                  | Most one call may spend, in whole tokens               |
| `SESSION_BUDGET`      | `0.05`                  | Most this process may spend, in whole tokens           |
| `PAYABLE_ASSETS`      | testnet USDC            | `network\|contract\|decimals\|symbol`, comma separated |
| `LOG_LEVEL`           | `info`                  | Logs go to stderr; stdout is the JSON-RPC stream       |

## Not built

An MCP tool that is itself paid, which `@x402/mcp` supports, needs an x402-aware MCP client. Claude Desktop and Claude Code are not, so only our own code could pay such a tool. `upto` payments need the resource server to offer that scheme. A signer in a separate process — so the process the model talks to could not sign at all — is the shape to reach for in production; here the key sits in the same process.
