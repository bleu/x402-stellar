import type { RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { UptoStellarServerScheme } from "@x402-stellar/upto/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { RouteConfig } from "@x402/core/http";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createPaywall } from "@x402-stellar/paywall";
import { stellarPaywall } from "@x402-stellar/paywall/stellar";
import { type NetworkConfig, NETWORK_META, Env, parseFacilitatorApiKeys } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface NetworkMiddleware {
  network: string;
  routePath: string;
  handler: RequestHandler;
}

interface ServerComponents {
  facilitatorClient: HTTPFacilitatorClient;
  x402Server: x402ResourceServer;
}

/**
 * Returns a selector that cycles through the configured facilitator API keys.
 *
 * @param commaSeparatedKeys - Raw FACILITATOR_API_KEY env value, allowing multiple comma-separated keys.
 * @returns A function that returns the next key on each call.
 * @throws Error when the input does not contain at least one non-empty key.
 */
export function createRoundRobinKeySelector(commaSeparatedKeys: string): () => string {
  const keys = parseFacilitatorApiKeys(commaSeparatedKeys);
  if (keys.length === 0) {
    throw new Error("FACILITATOR_API_KEY must contain at least one non-empty key");
  }

  let index = 0;
  return () => {
    const pos = index;
    index = (index + 1) % keys.length;
    logger.debug({ keyIndex: pos }, "Selecting API key");
    return keys[pos];
  };
}

function buildServerComponents(netConfig: NetworkConfig): ServerComponents {
  const getNextKey = netConfig.facilitatorApiKey
    ? createRoundRobinKeySelector(netConfig.facilitatorApiKey)
    : undefined;

  const facilitatorClient = new HTTPFacilitatorClient({
    url: netConfig.facilitatorUrl,
    createAuthHeaders: getNextKey
      ? async () => {
          const headers = { Authorization: `Bearer ${getNextKey()}` };
          return { verify: headers, settle: headers, supported: headers };
        }
      : undefined,
  });

  const x402Server = new x402ResourceServer(facilitatorClient)
    .register(netConfig.network, new ExactStellarScheme())
    // Fills in `method` and `routeTemplate` on the declared bazaar extension at
    // request time. Without it the facilitator rejects the declaration, because
    // `method` is required by the extension's own schema.
    .registerExtension(bazaarResourceServerExtension);

  return { facilitatorClient, x402Server };
}

function buildMiddleware(netConfig: NetworkConfig): NetworkMiddleware {
  const { x402Server } = buildServerComponents(netConfig);

  const paywall = createPaywall()
    .withNetwork(stellarPaywall)
    .withConfig({
      appName: "Simple Paywall Demo",
      stellarRpcUrl: netConfig.stellarRpcUrl,
    })
    .build();

  const { routeSuffix } = NETWORK_META[netConfig.network];
  const routePath = `/protected/${routeSuffix}`;

  const handler = paymentMiddleware(
    {
      [`GET ${routePath}`]: {
        accepts: [
          {
            scheme: "exact",
            price: Env.paymentPrice,
            network: netConfig.network,
            payTo: netConfig.serverStellarAddress,
          },
        ],
        description: Env.paymentDescription,
      },
    },
    x402Server,
    undefined,
    paywall,
    true,
  );

  return { network: netConfig.network, routePath, handler };
}

/**
 * Priced separately from PAYMENT_PRICE (which the paywall demo route uses) and
 * deliberately under a cent, so a `maxUsdPrice=0.01` search is not resting on an
 * inclusive comparison against exactly one cent.
 */
export const WEATHER_PRICE = "0.001";

/**
 * Route config for the paid weather endpoint, including the Bazaar discovery
 * extension that makes it catalogable. Exported so the declaration can be tested
 * without standing up the middleware.
 *
 * `method` and `routeTemplate` are absent here on purpose:
 * bazaarResourceServerExtension fills them in at request time, and the
 * facilitator rejects a declaration that never went through that enrichment.
 */
export function buildApiRouteConfig(netConfig: NetworkConfig): RouteConfig {
  return {
    accepts: [
      {
        scheme: "exact",
        price: WEATHER_PRICE,
        network: netConfig.network,
        payTo: netConfig.serverStellarAddress,
      },
    ],
    description: "Current weather and temperature for any city by name",
    // Kept inside the bazaar soft-drop limits: 32 characters, at most 5 tags.
    serviceName: "Stellar Weather",
    tags: ["weather", "forecast", "temperature", "city"],
    extensions: declareDiscoveryExtension({
      input: { city: "San Francisco" },
      inputSchema: {
        properties: { city: { type: "string", description: "City name to look up" } },
        required: ["city"],
      },
      output: {
        example: {
          city: "San Francisco",
          country: "United States",
          current: { weather: "clear sky", temperature_f: 63.4, humidity_pct: 68 },
        },
      },
    }),
  };
}

function buildApiMiddleware(netConfig: NetworkConfig): NetworkMiddleware {
  const { x402Server } = buildServerComponents(netConfig);

  const { routeSuffix } = NETWORK_META[netConfig.network];
  const routePath = `/weather/${routeSuffix}`;

  const handler = paymentMiddleware(
    { [`GET ${routePath}`]: buildApiRouteConfig(netConfig) },
    x402Server,
    undefined,
    undefined,
    true,
  );

  return { network: netConfig.network, routePath, handler };
}

/**
 * The ceiling the upto weather route quotes. The buyer signs this; the route
 * then charges somewhere at or below it, depending on the city.
 */
export const WEATHER_UPTO_CAP = "0.003";

/**
 * Route config for the ceiling-priced weather endpoint. Only `upto` is offered,
 * so an agent that reaches this route has to sign a cap rather than an amount.
 */
export function buildUptoApiRouteConfig(netConfig: NetworkConfig): RouteConfig {
  return {
    accepts: [
      {
        scheme: "upto",
        price: WEATHER_UPTO_CAP,
        network: netConfig.network,
        payTo: netConfig.serverStellarAddress,
      },
    ],
    description: "Current weather for any city, charged by city tier up to a ceiling",
    serviceName: "Stellar Weather Upto",
    tags: ["weather", "forecast", "upto", "ceiling"],
    extensions: declareDiscoveryExtension({
      input: { city: "Tokyo" },
      inputSchema: {
        properties: { city: { type: "string", description: "City name to look up" } },
        required: ["city"],
      },
      output: {
        example: {
          city: "Tokyo",
          country: "Japan",
          current: { weather: "clear sky", temperature_f: 71.2, humidity_pct: 54 },
          charged: { amountAtomic: "30000", scheme: "upto" },
        },
      },
    }),
  };
}

/**
 * Its own resource server, registering only the upto scheme. Keeping it apart
 * from the exact route means a facilitator without UPTO_CONTRACT_ID fails this
 * route alone, and the error names the kind it could not find.
 */
function buildUptoApiMiddleware(netConfig: NetworkConfig): NetworkMiddleware {
  const { facilitatorClient } = buildServerComponents(netConfig);

  const x402Server = new x402ResourceServer(facilitatorClient)
    .register(netConfig.network, new UptoStellarServerScheme())
    .registerExtension(bazaarResourceServerExtension);

  const { routeSuffix } = NETWORK_META[netConfig.network];
  const routePath = `/weather-upto/${routeSuffix}`;

  const handler = paymentMiddleware(
    { [`GET ${routePath}`]: buildUptoApiRouteConfig(netConfig) },
    x402Server,
    undefined,
    undefined,
    true,
  );

  return { network: netConfig.network, routePath, handler };
}

export function createPaymentMiddlewares(): NetworkMiddleware[] {
  return Env.networksConfig.map(buildMiddleware);
}

export function createApiPaymentMiddlewares(): NetworkMiddleware[] {
  return Env.networksConfig.map(buildApiMiddleware);
}

export function createUptoApiPaymentMiddlewares(): NetworkMiddleware[] {
  return Env.networksConfig.map(buildUptoApiMiddleware);
}
