import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { UptoStellarClientScheme } from "@x402-stellar/upto/client";

import { Env } from "./config/env.js";
import { SessionBudget } from "./budget.js";
import { logger } from "./logger.js";
import { createPayer } from "./payer.js";
import { createMcpServer } from "./server.js";
import { PaymentAbility, SIGNABLE_SCHEMES } from "./ability.js";

async function main(): Promise<void> {
  const network = Env.stellarNetwork;
  // One object answers "can this be paid" for both tools, so search cannot
  // offer something payment would refuse.
  const ability = new PaymentAbility(Env.assets, SIGNABLE_SCHEMES);
  const budget = new SessionBudget(Env.maxPayment, Env.sessionBudget);

  // Built once: the key is read at startup so a missing or malformed secret
  // fails here rather than on the first payment.
  const signer = createEd25519Signer(Env.stellarPrivateKey, network);

  const pay = createPayer({
    network,
    ability,
    budget,
    // Fresh scheme clients per call, so the per-call hooks that enforce the
    // budget cannot be crossed by two tool calls running at once.
    createSchemeClients: () => [
      new ExactStellarScheme(signer),
      new UptoStellarClientScheme({
        buyerSecret: Env.stellarPrivateKey,
        rpcUrl: Env.stellarRpcUrl,
        network,
      }),
    ],
    fetchImpl: globalThis.fetch,
    explorerBaseUrl: Env.explorerBaseUrl,
  });

  const server = createMcpServer({
    facilitatorUrl: Env.facilitatorUrl,
    ability,
    fetchImpl: globalThis.fetch,
    pay,
  });

  logger.info(
    {
      facilitator: Env.facilitatorUrl,
      network,
      payable: ability.describe(),
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
