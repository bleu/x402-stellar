# Architecture

This repository holds an x402 facilitator for Stellar, a Bazaar catalog, a paid demo endpoint, and two clients. This document shows the components, the flows between them, and the data they keep.

The x402 protocol is unchanged here. All protocol logic comes from the `@x402/*` packages. This code adds the service shell, the catalog, and the clients.

## Components

```mermaid
graph TB
    subgraph agent["Agent side"]
        MCP["examples/mcp-server<br/>MCP server, holds the buyer key"]
        CLI["examples/client-cli<br/>one-shot payer"]
    end

    subgraph seller["Seller side"]
        PW["examples/simple-paywall/server<br/>resource server, /weather/:network"]
    end

    subgraph fac["examples/facilitator (one process)"]
        FM["facilitator module<br/>/verify /settle /supported"]
        CM["catalog module<br/>/discovery/resources /discovery/search"]
        PM["prices module<br/>USD rates"]
    end

    DB[("Postgres + pgvector")]
    SOR["Soroban RPC<br/>Stellar testnet"]
    UC["contracts/upto-settlement<br/>UptoSettlement"]
    CG["CoinGecko<br/>optional"]

    MCP -->|"search"| CM
    MCP -->|"HTTP + payment"| PW
    CLI -->|"HTTP + payment"| PW
    PW -->|"verify, settle"| FM
    FM -->|"after settle"| CM
    FM -->|"submit"| SOR
    FM -.->|"upto scheme only"| UC
    CM --> DB
    PM --> DB
    PM -.-> CG
```

Each part has one job:

| Component          | Job                                                                    |
| ------------------ | ---------------------------------------------------------------------- |
| facilitator module | Validates a payment. Submits it to the network. Answers `/supported`.  |
| catalog module     | Records paid resources. Serves list and search.                        |
| prices module      | Keeps USD rates for the price filter.                                  |
| resource server    | Sells one endpoint. Returns `402` until the client pays.               |
| MCP server         | Gives an agent two tools: search the Bazaar, and call a paid endpoint. |
| client-cli         | Pays one endpoint from the command line.                               |
| UptoSettlement     | Enforces the cap of an `upto` payment on-chain.                        |
| packages/shared    | Shared helpers for x402 headers.                                       |
| packages/paywall   | Browser paywall UI for the demo client.                                |

Default ports: facilitator `4022`, resource server `3001`, Postgres `5442`.

## Flow 1: an exact payment

This is the default x402 flow. The buyer signs one transfer of a known amount.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Resource server
    participant F as Facilitator
    participant N as Stellar

    C->>S: GET /weather/testnet?city=...
    S-->>C: 402 + PAYMENT-REQUIRED
    Note over C: Client signs auth entries<br/>for one transfer
    C->>S: GET again + PAYMENT-SIGNATURE
    S->>F: POST /verify
    F-->>S: isValid
    S->>S: Run the handler
    S->>F: POST /settle
    F->>N: Submit transaction
    N-->>F: Transaction hash
    F-->>S: success + hash
    S-->>C: 200 + data + PAYMENT-RESPONSE
```

Three rules hold in this flow:

- The facilitator never holds the buyer key. It receives a signed authorization only.
- The facilitator rebuilds the transaction with itself as the source. It pays the fee.
- `/settle` verifies again. It never trusts an earlier `/verify`.

## Flow 2: an upto payment

The `upto` scheme lets the seller charge less than a signed ceiling. Stellar auth entries authorize an exact transfer, so a contract must hold the ceiling. The facilitator serves this scheme only when `UPTO_CONTRACT_ID` is set.

```mermaid
sequenceDiagram
    participant C as Client
    participant F as Facilitator
    participant U as UptoSettlement
    participant T as Token

    Note over C: Buyer signs settle(cap, payTo,<br/>deadline, salt).<br/>The amount stays unsigned.
    C->>F: PaymentPayload with the signed entry
    F->>U: settle(actual amount)
    U->>U: Check amount <= cap
    U->>U: Check payTo, deadline, salt
    U->>T: transfer(buyer -> payTo, actual)
    T-->>U: ok
    U-->>F: settled
```

The contract checks four things: the amount is not above the cap, the recipient matches, the deadline is not passed, and the salt is unused. The buyer signs one time for both steps.

## Flow 3: how a resource enters the catalog

There is no registration step. The catalog learns from settlements only.

```mermaid
graph LR
    A["Resource server declares<br/>extensions.bazaar in the 402"] --> B["Client copies the<br/>declaration into the payment"]
    B --> C["Facilitator settles"]
    C --> D["after-settle hook"]
    D --> E["extractDiscoveryInfo<br/>validates and cleans"]
    E --> F["Upsert catalog_resources<br/>+ append catalog_settlements"]
    F --> G["Embed the text<br/>MiniLM, 384 numbers"]
```

Points to know:

- The client copy is automatic. `@x402/core` merges `paymentRequired.extensions` into the payload.
- Validation is `@x402/extensions/bazaar`, not our own code. It checks the route template, cleans the service metadata, and validates `info` against its schema.
- A row is identified by `(resource, tool_name)`. Two MCP tools on one endpoint keep two rows.
- `accepts` holds the payment options seen in settlements. It is not the full set the seller declares.
- The hook never fails a settlement. A catalog error is logged only.

## Flow 4: hybrid search

`GET /discovery/search` ranks the catalog with two methods and joins the results.

```mermaid
graph TB
    Q["query text"] --> L["Lexical arm<br/>Postgres full-text<br/>ts_rank_cd"]
    Q --> V["Vector arm<br/>MiniLM embedding<br/>cosine distance"]
    FI["Filters: type, network, asset,<br/>tags, maxUsdPrice, ..."] --> L
    FI --> V
    L --> R["Reciprocal rank fusion<br/>sum of 1 / (60 + rank)"]
    V --> R
    R --> O["Ranked results<br/>+ quality signals"]
```

Design points:

- Both arms apply every filter. A filter is a hard limit, not a later trim.
- The two scores are not comparable, so only the ranks are used.
- A `FULL OUTER JOIN` keeps a row that one arm alone found.
- The lexical query ORs its terms. AND would match almost nothing.
- The model runs in the process. No API key and no network call.
- Ranking ignores usage. The `quality` numbers are shown, not scored.

## Flow 5: an agent discovers and pays

The MCP server gives an agent two free tools. It knows one URL: the facilitator.

```mermaid
sequenceDiagram
    participant U as User
    participant A as Agent
    participant M as MCP server
    participant B as Bazaar
    participant S as Resource server

    U->>A: "Weather in San Francisco, under a cent"
    A->>M: search_bazaar(query, maxUsdPrice=0.01)
    M->>B: GET /discovery/search
    B-->>M: resources + prices + parameters
    M-->>A: compact results, payable flags
    A->>M: paid_request(url, query)
    M->>M: Check asset, scheme, caps
    M->>S: GET, pay the 402, retry
    S-->>M: 200 + data + settlement
    M-->>A: data + transaction + budget left
    A-->>U: Answer, with the amount spent
```

The agent learns the parameter names from `extensions.bazaar.info.input` in the search result. Nothing is set up in advance.

Guards inside `paid_request`:

- An asset allowlist. Only listed assets can be signed for.
- Only the `exact` scheme. An `upto` price is refused.
- A per-call cap and a session budget.
- The budget is charged when the payment is signed. A lost answer can still be a spent payment.
- Payment headers from the caller are refused.

Every refusal returns a code from a closed set and a reason that is never empty.

## Data

```mermaid
erDiagram
    catalog_resources {
        text resource PK
        text tool_name PK
        text type
        text method
        text route_template
        jsonb accepts
        jsonb extensions
        text search_document
        tsvector search_tsv
        vector embedding
        text source
        timestamptz last_updated
    }
    catalog_settlements {
        bigserial id PK
        text resource FK
        text tool_name FK
        text asset
        text payer
        timestamptz settled_at
    }
    asset_usd_prices {
        text asset PK
        text coingecko_id
        numeric usd_price
        timestamptz fetched_at
    }
    catalog_resources ||--o{ catalog_settlements : "usage"
```

`asset_usd_prices` has no foreign key. Search joins it to the assets inside the `accepts` array at query time.

- `catalog_resources` holds one row for each endpoint, or for each MCP tool on an endpoint. `search_tsv` is generated from `search_document`. `embedding` has 384 numbers. Indexes: GIN on `search_tsv`, HNSW on `embedding`.
- `catalog_settlements` is append-only. A `GROUP BY` gives the `quality` numbers: calls, unique payers, and last call time. Payer addresses are public chain data.
- `asset_usd_prices` keeps the rates for `maxUsdPrice`. USD stablecoins use an assumed rate of 1.00, so the filter works without an API key. Other assets need CoinGecko, polled every 15 minutes. A rate older than one hour is not used.

## Configuration

The facilitator is one process with optional parts:

```mermaid
graph LR
    E1["FACILITATOR_STELLAR_PRIVATE_KEY"] --> P["facilitator process"]
    E2["DATABASE_URL"] -->|"enables"| C["catalog + search"]
    E3["COINGECKO_API_KEY"] -->|"enables"| PR["live rates"]
    E4["UPTO_CONTRACT_ID"] -->|"enables"| UP["upto scheme"]
    E5["FACILITATOR_STELLAR_CHANNEL_SECRETS"] -->|"enables"| CH["parallel settlement"]
```

Without `DATABASE_URL` the facilitator is stateless. Without `UPTO_CONTRACT_ID` it serves `exact` only. Channel accounts and a fee-bump signer give higher throughput, because each channel account keeps its own sequence number.

## Trust boundaries

```mermaid
graph TB
    subgraph buyer["Buyer machine"]
        K["Buyer key"]
        MC["MCP server or CLI"]
    end
    subgraph facil["Facilitator host"]
        FK["Facilitator key"]
        FP["facilitator process"]
    end
    K --- MC
    MC -->|"signed authorization<br/>fixed amount, asset, recipient"| FP
    FK --- FP
    FP -->|"fee payment + submission"| CHAIN["Stellar"]
```

- The buyer key stays on the buyer machine. The facilitator gets a signed authorization for one transfer.
- The facilitator key pays fees and submits transactions. It cannot change the amount or the recipient of an `exact` payment.
- For `upto`, the contract limits the facilitator. Without the contract, the facilitator could take the full cap.
- Catalog text comes from sellers. An agent reads it. Spending caps limit the damage of hostile text.

## What is not built

- No deployment. All parts run on localhost.
- No crawler for 402 responses, so `accepts` stays settlement-observed.
- No paid MCP tool. That needs an x402-aware MCP client.
- No asynchronous embedding. The embedding runs in the settle path.
- No usage in the ranking.
