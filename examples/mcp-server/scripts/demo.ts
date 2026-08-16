import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

import { PaymentAbility, SIGNABLE_SCHEMES } from "../src/ability.js";
import { SessionBudget } from "../src/budget.js";
import { Env } from "../src/config/env.js";
import { createPayer } from "../src/payer.js";
import { createMcpServer } from "../src/server.js";

/**
 * Runs the demo's tool calls without Claude in the loop.
 *
 * Same server, same tools, same key, same testnet: only the agent is missing.
 * It exists so a failure on recording day can be reproduced in one command
 * instead of by re-prompting a model.
 *
 * Usage: pnpm demo "current weather for a city" [--max-usd 0.01] [--refuse]
 */
const args = process.argv.slice(2);
const query = args.find((arg) => !arg.startsWith("--")) ?? "an api that answers a question";
const maxUsdIndex = args.indexOf("--max-usd");
const maxUsdPrice = maxUsdIndex >= 0 ? Number(args[maxUsdIndex + 1]) : undefined;
// Forces the refusal path with a cap nothing can satisfy, so the structured
// error can be rehearsed too.
const refuse = args.includes("--refuse");

function show(label: string, value: unknown): void {
  process.stdout.write(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}\n`);
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const network = Env.stellarNetwork;
  const ability = new PaymentAbility(Env.assets, SIGNABLE_SCHEMES);
  const budget = new SessionBudget(refuse ? 1n : Env.maxPayment, refuse ? 1n : Env.sessionBudget);
  const signer = createEd25519Signer(Env.stellarPrivateKey, network);

  const server = createMcpServer({
    facilitatorUrl: Env.facilitatorUrl,
    ability,
    fetchImpl: globalThis.fetch,
    pay: createPayer({
      network,
      ability,
      budget,
      createSchemeClient: () => new ExactStellarScheme(signer),
      fetchImpl: globalThis.fetch,
      explorerBaseUrl: Env.explorerBaseUrl,
    }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "demo-rehearsal", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const search = textOf(
    await client.callTool({
      name: "search_bazaar",
      arguments: { query, ...(maxUsdPrice !== undefined ? { maxUsdPrice } : {}) },
    }),
  );
  show("search_bazaar", search);

  const results = (search.results ?? []) as Record<string, unknown>[];
  const target = results.find((result) => result.payable === true);
  if (!target) {
    process.stdout.write("\nNo payable result to call. Stopping here.\n");
    return;
  }

  // Calls the endpoint with the example values it declared, which is what an
  // agent reads out of the catalog before substituting its own.
  const call = (target.call ?? {}) as { method?: string; queryParams?: Record<string, string> };
  const paid = textOf(
    await client.callTool({
      name: "paid_request",
      arguments: {
        url: target.resource as string,
        ...(call.method ? { method: call.method } : {}),
        ...(call.queryParams ? { query: call.queryParams } : {}),
      },
    }),
  );
  show("paid_request", paid);

  // Second search: the settlement should have moved this row's usage signals,
  // which is auto-cataloging visible from the outside.
  const after = textOf(
    await client.callTool({
      name: "search_bazaar",
      arguments: { query, ...(maxUsdPrice !== undefined ? { maxUsdPrice } : {}) },
    }),
  );
  const row = ((after.results ?? []) as Record<string, unknown>[]).find(
    (result) => result.resource === target.resource,
  );
  show("quality after paying", { before: target.quality, after: row?.quality });

  // A second identical call, which the session budget should refuse. This is the
  // last beat of the recording, and the only one that exercises a rejection, so
  // it is worth rehearsing rather than discovering on camera.
  const second = textOf(
    await client.callTool({
      name: "paid_request",
      arguments: {
        url: target.resource as string,
        ...(call.method ? { method: call.method } : {}),
        ...(call.queryParams ? { query: call.queryParams } : {}),
      },
    }),
  );
  show("paid_request, second call", second);

  process.stdout.write(`\nbudget: ${JSON.stringify(budget.report())}\n`);
}

main().catch((error) => {
  process.stderr.write(`\ndemo failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
