import type { DiscoveredResource } from "@x402/extensions/bazaar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import type { CatalogRecord, ResourceKey } from "./store.js";

/**
 * What a future buyer would be quoted for this resource, which is not always
 * what this one paid.
 *
 * A partial settle rewrites `requirements.amount` down to the charge before the
 * settle call, so recording that would advertise the last charge as the price
 * and leave a `maxUsdPrice` filter comparing against less than the call can
 * cost. The quoted ceiling survives in `payload.accepted`, which the `upto`
 * scheme pins to the buyer's signed maxAmount.
 */
export function quotedRequirements(
  payload: PaymentPayload,
  settled: PaymentRequirements,
): PaymentRequirements {
  const quoted = payload.accepted?.amount;
  if (typeof quoted !== "string" || !/^\d+$/.test(quoted)) return settled;
  return BigInt(quoted) > BigInt(settled.amount) ? { ...settled, amount: quoted } : settled;
}

/**
 * Turns the SDK's extraction result into a catalog row.
 *
 * `extractDiscoveryInfo` returns `method` and `routeTemplate` for HTTP
 * resources and `toolName` for MCP ones, never both, so those columns are
 * absent by construction on the other kind. Shared by the settle-path hook and
 * the seed script so a seeded row cannot differ in shape from an observed one.
 */
export function toCatalogRecord(
  discovered: DiscoveredResource,
  requirements: PaymentRequirements,
  source: CatalogRecord["source"] = "settlement",
): CatalogRecord {
  const toolName = "toolName" in discovered ? discovered.toolName : undefined;

  return {
    resource: discovered.resourceUrl,
    type: discovered.discoveryInfo.input.type,
    ...(toolName ? { toolName } : {}),
    ...("method" in discovered && discovered.method ? { method: discovered.method } : {}),
    ...("routeTemplate" in discovered && discovered.routeTemplate
      ? { routeTemplate: discovered.routeTemplate }
      : {}),
    x402Version: discovered.x402Version,
    accepts: [requirements as unknown as Record<string, unknown>],
    extensions: discovered.extensions,
    description: discovered.description,
    mimeType: discovered.mimeType,
    serviceName: discovered.serviceName,
    tags: discovered.tags,
    iconUrl: discovered.iconUrl,
    source,
  };
}

/** The row a discovered resource belongs to. */
export function toResourceKey(discovered: DiscoveredResource): ResourceKey {
  return {
    resource: discovered.resourceUrl,
    toolName: "toolName" in discovered ? discovered.toolName : undefined,
  };
}
