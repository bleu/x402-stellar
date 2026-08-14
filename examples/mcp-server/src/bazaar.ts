import type { DiscoveryResource, SearchDiscoveryResourcesResponse } from "@x402/extensions/bazaar";

import type { PaymentAbility, PaymentOptionLike } from "./ability.js";
import { fromAtomic } from "./assets.js";
import { ToolError } from "./errors.js";

/**
 * Search parameters. `query`, `type`, `payTo`, `scheme`, `network`, `extensions`
 * and `limit` are the spec's; `maxUsdPrice`, `asset`, `tags` and `urlSubstring`
 * are our facilitator's additions, matching the reference Bazaar's filter set.
 *
 * The SDK's own `withBazaar` client cannot express the additions, which is why
 * this is a plain fetch. A conformance test in the facilitator package proves
 * that client still works against the same endpoint.
 */
export interface SearchParams {
  query: string;
  maxUsdPrice?: number;
  network?: string;
  asset?: string[];
  tags?: string[];
  urlSubstring?: string;
  limit?: number;
}

/** What the model sees for one hit: enough to decide, and how to call it. */
export interface CompactResource {
  resource: string;
  type: string;
  serviceName?: string;
  description?: string;
  tags?: string[];
  method?: string;
  routeTemplate?: string;
  /** Whether this server can pay for it at all: asset allowlist and scheme. */
  payable: boolean;
  price?: {
    amountAtomic: string;
    asset: string;
    network: string;
    scheme?: string;
    decimals?: number;
    usd?: string;
  };
  /** Read from the resource's own discovery declaration. */
  call?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  lastUpdated?: string;
}

export interface CompactSearchResult {
  query: string;
  searchMethod?: string;
  partialResults?: boolean;
  warnings?: string[];
  results: CompactResource[];
  notes?: string[];
}

interface BazaarDeps {
  facilitatorUrl: string;
  ability: PaymentAbility;
  fetchImpl: typeof globalThis.fetch;
}

function buildSearchUrl(facilitatorUrl: string, params: SearchParams): string {
  const url = new URL(`${facilitatorUrl.replace(/\/+$/, "")}/discovery/search`);
  url.searchParams.set("query", params.query);
  if (params.maxUsdPrice !== undefined) {
    url.searchParams.set("maxUsdPrice", String(params.maxUsdPrice));
  }
  if (params.network) url.searchParams.set("network", params.network);
  if (params.asset?.length) url.searchParams.set("asset", params.asset.join(","));
  if (params.tags?.length) url.searchParams.set("tags", params.tags.join(","));
  if (params.urlSubstring) url.searchParams.set("urlSubstring", params.urlSubstring);
  if (params.limit !== undefined) url.searchParams.set("limit", String(params.limit));
  return url.toString();
}

/** The bazaar extension's `info.input`, which describes how to call the route. */
function readDiscoveryInput(resource: DiscoveryResource): Record<string, unknown> | undefined {
  const bazaar = resource.extensions?.bazaar;
  if (!bazaar || typeof bazaar !== "object") return undefined;
  const info = (bazaar as { info?: unknown }).info;
  if (!info || typeof info !== "object") return undefined;
  const input = (info as { input?: unknown }).input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
}

/**
 * Keeps the fields that tell an agent how to build the request and drops the
 * JSON Schema boilerplate, except for body endpoints where the agent has to
 * construct the payload itself.
 */
function toCallShape(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;

  const call: Record<string, unknown> = {};
  for (const key of ["method", "queryParams", "pathParams", "headers", "bodyType", "body"]) {
    if (input[key] !== undefined) call[key] = input[key];
  }
  // MCP-type resources name a tool rather than a route.
  for (const key of ["toolName", "transport", "inputSchema", "example"]) {
    if (input[key] !== undefined) call[key] = input[key];
  }
  return Object.keys(call).length > 0 ? call : undefined;
}

/**
 * Picks the option to quote: the cheapest one this server can actually pay,
 * falling back to the first offered so an unpayable resource still shows a price.
 */
function pickOption(
  resource: DiscoveryResource,
  ability: PaymentAbility,
): { option: PaymentOptionLike; payable: boolean } | undefined {
  const options = (resource.accepts ?? []) as unknown as PaymentOptionLike[];
  if (options.length === 0) return undefined;

  const payableOptions = options.filter((option) => ability.canPay(option));

  if (payableOptions.length === 0) {
    return { option: options[0], payable: false };
  }

  const cheapest = payableOptions.reduce((best, option) => {
    const bestAmount = BigInt(best.amount ?? "0");
    const amount = BigInt(option.amount ?? "0");
    return amount < bestAmount ? option : best;
  });
  return { option: cheapest, payable: true };
}

function toCompact(resource: DiscoveryResource, ability: PaymentAbility): CompactResource {
  const picked = pickOption(resource, ability);
  const option = picked?.option;
  // Only priced in USD when the option is genuinely payable: an allowlisted
  // asset under an unsignable scheme is not a price this wallet can act on.
  const declared = picked?.payable && option ? ability.assetFor(option) : undefined;

  return {
    resource: resource.resource,
    type: resource.type,
    ...(resource.serviceName ? { serviceName: resource.serviceName } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.tags ? { tags: resource.tags } : {}),
    payable: picked?.payable ?? false,
    ...(option
      ? {
          price: {
            amountAtomic: String(option.amount ?? ""),
            asset: String(option.asset ?? ""),
            network: String(option.network ?? ""),
            ...(option.scheme ? { scheme: option.scheme } : {}),
            ...(declared
              ? {
                  decimals: declared.decimals,
                  // Payable assets are declared USD stablecoins, so atomic units
                  // convert without asking a price feed.
                  usd: fromAtomic(BigInt(option.amount ?? "0"), declared.decimals),
                }
              : {}),
          },
        }
      : {}),
    ...(toCallShape(readDiscoveryInput(resource))
      ? { call: toCallShape(readDiscoveryInput(resource)) }
      : {}),
    ...(resource.lastUpdated ? { lastUpdated: resource.lastUpdated } : {}),
    ...((resource as { quality?: Record<string, unknown> }).quality
      ? { quality: (resource as { quality?: Record<string, unknown> }).quality }
      : {}),
  };
}

/**
 * Queries the facilitator's Bazaar and reshapes the response for a model: the
 * fields that drive the next action, with prices already converted so nothing
 * downstream has to do atomic-unit arithmetic.
 */
export async function searchBazaar(
  deps: BazaarDeps,
  params: SearchParams,
): Promise<CompactSearchResult> {
  const url = buildSearchUrl(deps.facilitatorUrl, params);

  let response: Response;
  try {
    response = await deps.fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new ToolError(
      "search_unavailable",
      `Could not reach the Bazaar at ${deps.facilitatorUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { facilitatorUrl: deps.facilitatorUrl },
    );
  }

  const text = await response.text();
  if (!response.ok) {
    // The facilitator answers errors as {"error": "..."}; keep its wording.
    let upstream: string | undefined;
    try {
      upstream = (JSON.parse(text) as { error?: string }).error;
    } catch {
      upstream = text.slice(0, 200) || undefined;
    }
    throw new ToolError("search_failed", upstream ?? `Bazaar returned ${response.status}`, {
      status: response.status,
    });
  }

  let body: SearchDiscoveryResourcesResponse;
  try {
    body = JSON.parse(text) as SearchDiscoveryResourcesResponse;
  } catch {
    throw new ToolError("search_failed", "Bazaar returned a body that is not JSON", {
      status: response.status,
    });
  }

  const results = (body.resources ?? []).map((resource) => toCompact(resource, deps.ability));
  const unpayable = results.filter((result) => !result.payable).length;
  // `searchMethod` and `warnings` are our facilitator's additions to the spec's
  // response, so they are read off the side of the SDK type rather than in it.
  const extras = body as { searchMethod?: string; warnings?: string[] };

  return {
    query: params.query,
    ...(extras.searchMethod ? { searchMethod: extras.searchMethod } : {}),
    ...(body.partialResults ? { partialResults: true } : {}),
    ...(Array.isArray(extras.warnings) ? { warnings: extras.warnings } : {}),
    results,
    ...(unpayable > 0
      ? {
          notes: [
            `${unpayable} result(s) cannot be paid by this wallet, which holds ${deps.ability.describe()}. They are listed but paid_request will refuse them.`,
          ],
        }
      : {}),
  };
}
