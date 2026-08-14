import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

import { Env } from "./config/env.js";
import { SessionBudget } from "./budget.js";
import { logger } from "./logger.js";
import { createPayer } from "./payer.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const assets = Env.assets;
  const network = Env.stellarNetwork;
  const budget = new SessionBudget(Env.maxPayment, Env.sessionBudget);

  // Built once: the key is read at startup so a missing or malformed secret
  // fails here rather than on the first payment.
  const signer = createEd25519Signer(Env.stellarPrivateKey, network);

  const pay = createPayer({
    network,
    assets,
    budget,
    // A fresh scheme client per call, so the per-call hooks that enforce the
    // budget cannot be crossed by two tool calls running at once.
    createSchemeClient: () => new ExactStellarScheme(signer),
    fetchImpl: globalThis.fetch,
    explorerBaseUrl: Env.explorerBaseUrl,
  });

  const server = createMcpServer({
    facilitatorUrl: Env.facilitatorUrl,
    assets,
    fetchImpl: globalThis.fetch,
    pay,
  });

  logger.info(
    {
      facilitator: Env.facilitatorUrl,
      network,
      payable: assets.list().map((asset) => asset.symbol),
      budget: budget.report(),
    },
    "x402 Bazaar MCP server ready on stdio",
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  logger.fatal({ err: error }, "Fatal error");
  process.exit(1);
});
