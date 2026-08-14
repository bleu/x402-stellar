import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * A synthetic service for the demo catalog.
 *
 * Entries are turned into real PaymentPayloads and pushed through the same
 * `extractDiscoveryInfo` and upsert path a settlement takes, so the corpus
 * cannot contain a shape real traffic could not produce -- and seeding doubles
 * as a test of the extraction path.
 */
export interface SeedEntry {
  resource: string;
  description: string;
  asset: string;
  /** Atomic units, 7 decimals. */
  amount: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  routeTemplate?: string;
  /** Set for an MCP tool rather than an HTTP endpoint. */
  toolName?: string;
  queryParams?: Record<string, unknown>;
  outputExample?: Record<string, unknown>;
}

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * Twenty services, built to exercise each branch of search rather than to look
 * realistic: rival weather endpoints so the live demo endpoint has competition,
 * a spread of assets including one with no USD rate, a templated route, and
 * entries that trip the bazaar soft-drop rules.
 */
export const SEED_CORPUS: SeedEntry[] = [
  // -- Rival weather services. The live demo endpoint has to beat these.
  {
    // A real weather service and cheap enough to pass a one-cent ceiling, so the
    // live endpoint has to win on relevance rather than on price or scarcity.
    resource: "https://api.weatherstack.example/observations",
    serviceName: "WeatherStack",
    description: "Raw barometric and humidity observations from a named weather station",
    tags: ["weather", "observations", "stations"],
    asset: USDC_TESTNET,
    amount: "50000", // $0.005
    queryParams: { station: "EGLL" },
    outputExample: { station: "EGLL", pressure_hpa: 1013 },
  },
  {
    resource: "https://api.forecastpro.example/hourly",
    serviceName: "ForecastPro",
    description: "Hourly weather forecast up to fourteen days ahead for a city",
    tags: ["weather", "forecast", "hourly"],
    asset: USDC_TESTNET,
    amount: "2500000", // $0.25 -- deliberately pricier than a one-cent ceiling
    queryParams: { city: "Paris", days: 7 },
    outputExample: { city: "Paris", hourly: [] },
  },
  {
    // Thin description: little for either arm to work with.
    resource: "https://api.quickweather.example/v1/now",
    serviceName: "QuickWeather",
    description: "Weather data",
    tags: ["weather"],
    asset: USDC_TESTNET,
    amount: "10000",
    queryParams: { q: "Berlin" },
  },
  {
    // No serviceName at all, so ranking rests on the description and url.
    resource: "https://meteo-anon.example/api/conditions",
    description: "Atmospheric conditions, wind speed and humidity by coordinates",
    tags: ["weather", "wind"],
    asset: "XLM",
    amount: "300000", // 0.03 XLM
    queryParams: { lat: 48.85, lon: 2.35 },
  },
  {
    resource: "https://api.climatearchive.example/records",
    serviceName: "Climate Archive",
    description: "Long-run historical temperature and rainfall records by station",
    tags: ["climate", "history", "temperature"],
    asset: USDC_TESTNET,
    amount: "150000",
    queryParams: { station: "EGLL", year: 1990 },
  },

  // -- Geocoding and mapping.
  {
    resource: "https://api.geocodr.example/v1/forward",
    serviceName: "Geocodr",
    description: "Turn a street address into latitude and longitude coordinates",
    tags: ["geocoding", "maps", "address"],
    asset: USDC_TESTNET,
    amount: "20000",
    queryParams: { address: "1 Market St, San Francisco" },
    outputExample: { latitude: 37.79, longitude: -122.39 },
  },
  {
    resource: "https://api.geocodr.example/v1/reverse",
    serviceName: "Geocodr Reverse",
    description: "Turn coordinates back into the nearest postal address",
    tags: ["geocoding", "reverse", "address"],
    asset: USDC_TESTNET,
    amount: "20000",
    queryParams: { lat: 37.79, lon: -122.39 },
  },
  {
    // Templated route: the catalog must key this by the template, not the path.
    resource: "https://api.tilehost.example/tiles/14/8192/5461",
    routeTemplate: "/tiles/:z/:x/:y",
    serviceName: "TileHost",
    description: "Raster map tiles for a slippy map viewer",
    tags: ["maps", "tiles"],
    asset: USDC_TESTNET,
    amount: "5000",
    queryParams: { style: "satellite" },
  },
  {
    resource: "https://api.routeplanner.example/directions",
    serviceName: "RoutePlanner",
    description: "Driving and walking directions between two places",
    tags: ["maps", "routing", "directions"],
    asset: "XLM",
    amount: "500000",
    queryParams: { from: "Berlin", to: "Prague" },
  },

  // -- Financial data.
  {
    resource: "https://api.tickerfeed.example/quote",
    serviceName: "TickerFeed",
    description: "Real-time equity and index price quotes by ticker symbol",
    tags: ["finance", "stocks", "quotes"],
    asset: USDC_TESTNET,
    amount: "100000",
    queryParams: { symbol: "AAPL" },
    outputExample: { symbol: "AAPL", price: 214.32 },
  },
  {
    resource: "https://api.fxrates.example/convert",
    serviceName: "FX Rates",
    description: "Convert an amount between two fiat currencies at the live rate",
    tags: ["finance", "forex", "currency"],
    asset: USDC_TESTNET,
    amount: "30000",
    queryParams: { from: "USD", to: "EUR", amount: 100 },
  },
  {
    // No USD mapping for this asset: the price filter must keep it and warn.
    resource: "https://api.cryptodepth.example/orderbook",
    serviceName: "CryptoDepth",
    description: "Order book depth and spread for a crypto trading pair",
    tags: ["finance", "crypto", "orderbook"],
    asset: "CUNMAPPEDSEEDASSET",
    amount: "1000",
    queryParams: { pair: "XLM/USD" },
  },

  // -- Text and language.
  {
    resource: "https://api.translately.example/v2/translate",
    serviceName: "Translately",
    description: "Translate text between more than fifty languages",
    tags: ["language", "translation", "text"],
    asset: USDC_TESTNET,
    amount: "40000",
    queryParams: { text: "hello", target: "fr" },
  },
  {
    resource: "https://api.summarise.example/article",
    serviceName: "Summarise",
    description: "Condense a long article into a short abstract",
    tags: ["language", "summarisation", "text"],
    asset: USDC_TESTNET,
    amount: "80000",
    queryParams: { url: "https://example.com/article" },
  },
  {
    // Over-long serviceName: sanitizeResourceServiceMetadata drops it entirely.
    resource: "https://api.sentimentality.example/score",
    serviceName: "Sentimentality Analysis Service For Long Documents",
    description: "Score the sentiment of a passage from negative to positive",
    tags: ["language", "sentiment"],
    asset: USDC_TESTNET,
    amount: "25000",
    queryParams: { text: "this is great" },
  },

  // -- Reference data.
  {
    // Eight tags: the sanitizer keeps the first five.
    resource: "https://api.countryfacts.example/country",
    serviceName: "CountryFacts",
    description: "Population, currency, capital and calling code for a country",
    tags: ["reference", "countries", "population", "currency", "capital", "geography", "iso", "un"],
    asset: USDC_TESTNET,
    amount: "15000",
    queryParams: { code: "JP" },
  },
  {
    resource: "https://api.holidaycal.example/holidays",
    serviceName: "HolidayCal",
    description: "Public holidays for a country and year",
    tags: ["reference", "holidays", "calendar"],
    asset: "XLM",
    amount: "200000",
    queryParams: { country: "DE", year: 2026 },
  },
  {
    resource: "https://api.airportdb.example/airport",
    serviceName: "AirportDB",
    description: "Runway, elevation and timezone details for an airport code",
    tags: ["reference", "aviation", "airports"],
    asset: USDC_TESTNET,
    amount: "12000",
    queryParams: { iata: "SFO" },
  },
  {
    resource: "https://api.newsdigest.example/headlines",
    serviceName: "NewsDigest",
    description: "Top news headlines by topic and region",
    tags: ["news", "headlines", "media"],
    asset: USDC_TESTNET,
    amount: "60000",
    queryParams: { topic: "technology" },
  },

  // -- An MCP tool, to show row identity is per tool rather than per endpoint.
  {
    resource: "https://mcp.toolhub.example/rpc",
    toolName: "lookup_company",
    serviceName: "ToolHub",
    description: "Look up a company's registration and filing history",
    tags: ["reference", "companies", "mcp"],
    asset: USDC_TESTNET,
    amount: "90000",
  },
];

/**
 * A JSON Schema matching the example values. The extension's `info` is validated
 * against its own `schema`, so declaring every parameter a string would reject
 * any entry whose example carries a number.
 */
function schemaOf(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [name, { type: typeof value }]),
  );
}

/**
 * Builds the PaymentPayload and PaymentRequirements a settlement would have
 * carried for this entry, including the bazaar extension enriched the way
 * bazaarResourceServerExtension enriches it at request time.
 */
export function seedPayloadOf(entry: SeedEntry): {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
} {
  const declared = entry.toolName
    ? declareDiscoveryExtension({
        toolName: entry.toolName,
        description: entry.description,
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      })
    : declareDiscoveryExtension({
        input: entry.queryParams ?? {},
        inputSchema: { properties: schemaOf(entry.queryParams ?? {}) },
        ...(entry.outputExample ? { output: { example: entry.outputExample } } : {}),
      });

  // MCP extensions carry no method; HTTP ones need the one enrichment adds.
  const bazaar = entry.toolName
    ? declared.bazaar
    : {
        ...declared.bazaar,
        info: {
          ...declared.bazaar.info,
          input: { ...declared.bazaar.info.input, method: "GET" },
        },
        ...(entry.routeTemplate ? { routeTemplate: entry.routeTemplate } : {}),
      };

  const requirements = {
    scheme: "exact",
    network: "stellar:testnet",
    asset: entry.asset,
    amount: entry.amount,
    payTo: "GSEEDMERCHANTADDRESSPLACEHOLDER",
    maxTimeoutSeconds: 300,
    extra: {},
  } as unknown as PaymentRequirements;

  const paymentPayload = {
    x402Version: 2,
    resource: {
      url: entry.resource,
      description: entry.description,
      mimeType: "application/json",
      ...(entry.serviceName ? { serviceName: entry.serviceName } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
    },
    accepted: requirements,
    extensions: { bazaar },
    payload: {},
  } as unknown as PaymentPayload;

  return { paymentPayload, requirements };
}
