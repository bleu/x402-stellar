import { Router, type Request, type Response, type Router as RouterType } from "express";
import { setSettlementOverrides } from "@x402/express";
import { Env, NETWORK_META } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { uptoSettlementAmount } from "./uptoPricing.js";

const router: RouterType = Router();

const OPEN_METEO_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * WMO Weather interpretation codes → human-readable descriptions.
 * @see https://open-meteo.com/en/docs#weathervariables
 */
const WMO_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snowfall",
  73: "moderate snowfall",
  75: "heavy snowfall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  admin1?: string;
}

interface ForecastCurrent {
  temperature_2m: number;
  relative_humidity_2m: number;
  weather_code: number;
  wind_speed_10m: number;
}

async function geocodeCity(city: string): Promise<GeocodingResult | null> {
  const url = `${OPEN_METEO_GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.error(
      { status: res.status, statusText: res.statusText, city },
      "Upstream geocoding request to Open-Meteo failed",
    );
    throw new Error(`Geocoding API request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { results?: GeocodingResult[] };
  return data.results?.[0] ?? null;
}

async function fetchForecast(lat: number, lon: number): Promise<ForecastCurrent | null> {
  const url =
    `${OPEN_METEO_FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { current?: ForecastCurrent };
  return data.current ?? null;
}

const validSuffixes = Env.networksConfig.map((n) => NETWORK_META[n.network].routeSuffix);

type Forecast =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

async function forecastFor(city: string): Promise<Forecast> {
  try {
    const location = await geocodeCity(city);
    if (!location) {
      return { ok: false, status: 404, error: `City not found: ${city}` };
    }

    const current = await fetchForecast(location.latitude, location.longitude);
    if (!current) {
      return { ok: false, status: 502, error: "Failed to fetch forecast from upstream" };
    }

    return {
      ok: true,
      body: {
        city: location.name,
        region: location.admin1 ?? null,
        country: location.country,
        coordinates: {
          latitude: location.latitude,
          longitude: location.longitude,
        },
        current: {
          weather: WMO_CODES[current.weather_code] ?? `unknown (code ${current.weather_code})`,
          weather_code: current.weather_code,
          temperature_f: current.temperature_2m,
          humidity_pct: current.relative_humidity_2m,
          wind_speed_mph: current.wind_speed_10m,
        },
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    logger.error({ err, city }, "Weather API upstream error");
    return { ok: false, status: 502, error: "Upstream weather service unavailable" };
  }
}

/** Returns the requested city, or writes the 4xx that says why it cannot. */
function readCity(req: Request<{ network: string }>, res: Response): string | undefined {
  if (!Env.paywallDisabled && !validSuffixes.includes(req.params.network)) {
    res.status(404).json({ error: "Network not found" });
    return undefined;
  }

  const city = (req.query.city as string | undefined)?.trim();
  if (!city) {
    res.status(400).json({ error: "Missing required query parameter: city" });
    return undefined;
  }
  return city;
}

router.get("/weather/:network", async (req, res) => {
  const city = readCity(req, res);
  if (!city) return;

  const forecast = await forecastFor(city);
  if (!forecast.ok) {
    res.status(forecast.status).json({ error: forecast.error });
    return;
  }
  res.json(forecast.body);
});

/**
 * The same forecast, priced with a ceiling instead of an exact amount. The
 * buyer signs 0.003; this route decides what it actually charges once it knows
 * whether it could answer, and a 4xx here cancels the payment outright.
 */
router.get("/weather-upto/:network", async (req, res) => {
  const city = readCity(req, res);
  if (!city) return;

  const forecast = await forecastFor(city);
  if (!forecast.ok) {
    res.status(forecast.status).json({ error: forecast.error });
    return;
  }

  const amount = uptoSettlementAmount(city);
  setSettlementOverrides(res, { amount });
  res.json({ ...forecast.body, charged: { amountAtomic: amount, scheme: "upto" } });
});

export { router as apiRouter };
