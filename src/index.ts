import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Open-Meteo endpoints (no API key required)
const GEOCODING_BASE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";

// Defaults for Ukraine (Kyiv)
const DEFAULT_LATITUDE = 50.4501;
const DEFAULT_LONGITUDE = 30.5234;
const DEFAULT_TIMEZONE = "Europe/Kyiv";
const DEFAULT_LANGUAGE = "uk";

// Simple Ukrainian translations used in responses
const T = {
  forecastFor: "Прогноз для",
  temperature: "Температура",
  wind: "Вітер",
  noData: "Дані недоступні",
  failed: "Не вдалося отримати дані",
  current: "Поточні умови",
  noAlerts: "Поточні попередження відсутні або не доступні через конфігурацію сервера",
};

// Create server instance
const server = new McpServer({
  name: "weather-ukraine",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

async function makeRequest<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error("Request error", err);
    return null;
  }
}

interface GeocodingResult {
  results?: Array<{ latitude: number; longitude: number; name: string; country: string }>;
}

async function geocodeCity(city: string): Promise<{ latitude: number; longitude: number; name?: string } | null> {
  const url = `${GEOCODING_BASE}?name=${encodeURIComponent(city)}&count=1&language=${DEFAULT_LANGUAGE}`;
  const data = await makeRequest<GeocodingResult>(url);
  const first = data?.results?.[0];
  if (!first) return null;
  return { latitude: first.latitude, longitude: first.longitude, name: first.name };
}

interface OpenMeteoForecast {
  latitude: number;
  longitude: number;
  generationtime_ms?: number;
  utc_offset_seconds?: number;
  timezone?: string;
  current_weather?: {
    temperature: number;
    windspeed: number;
    winddirection: number;
    weathercode: number;
    time: string;
  };
  daily?: Record<string, any>;
}

function formatForecastText(lat: number, lon: number, data: OpenMeteoForecast, placeName?: string) {
  const loc = placeName ? `${placeName} (${lat.toFixed(4)}, ${lon.toFixed(4)})` : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const lines: string[] = [];
  lines.push(`${T.forecastFor} ${loc}`);
  if (data.current_weather) {
    const cur = data.current_weather;
    lines.push("\n" + T.current + ":");
    lines.push(`${T.temperature}: ${cur.temperature} °C`);
    lines.push(`${T.wind}: ${cur.windspeed} km/h (${cur.winddirection}°)`);
    lines.push(`Час: ${cur.time}`);
  } else {
    lines.push(T.noData);
  }

  // Add simple daily summary if available
  if (data.daily) {
    const dates = data.daily.time || [];
    const maxTemps = data.daily.temperature_2m_max || [];
    const minTemps = data.daily.temperature_2m_min || [];
    const precip = data.daily.precipitation_sum || [];
    if (dates.length > 0) {
      lines.push("\nДенний прогноз:");
      for (let i = 0; i < Math.min(dates.length, 7); i++) {
        lines.push(`${dates[i]} — ${T.temperature}: ${minTemps[i]}…${maxTemps[i]} °C, опади: ${precip[i]} мм`);
      }
    }
  }

  return lines.join("\n");
}

// Forecast tool: accepts city OR latitude+longitude. If no params provided, defaults to Kyiv.
server.tool(
  "get_forecast",
  "Отримати прогноз погоди для місця в Україні (місто або координати). Якщо нічого не вказано — Київ.",
  {
    city: z.string().optional().describe("Назва міста (наприклад 'Kyiv')"),
    latitude: z.number().min(-90).max(90).optional().describe("Широта"),
    longitude: z.number().min(-180).max(180).optional().describe("Довгота"),
  },
  async (args: { city?: string; latitude?: number; longitude?: number }) => {
    const { city, latitude, longitude } = args;
    let lat = latitude;
    let lon = longitude;
    let placeName: string | undefined;

    if (!lat || !lon) {
      if (city) {
        const geo = await geocodeCity(city);
        if (!geo) {
          return { content: [{ type: "text", text: `${T.failed}: не знайдено місто '${city}'` }] };
        }
        lat = geo.latitude;
        lon = geo.longitude;
        placeName = geo.name;
      } else {
        lat = DEFAULT_LATITUDE;
        lon = DEFAULT_LONGITUDE;
        placeName = "Kyiv";
      }
    }

    // Build Open-Meteo forecast URL
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current_weather: "true",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
      timezone: DEFAULT_TIMEZONE,
      temperature_unit: "celsius",
      windspeed_unit: "kmh",
    });

    const url = `${FORECAST_BASE}?${params.toString()}`;
    const data = await makeRequest<OpenMeteoForecast>(url);
    if (!data) {
      return { content: [{ type: "text", text: `${T.failed}: помилка при отриманні даних` }] };
    }

    const text = formatForecastText(lat!, lon!, data, placeName);
    return { content: [{ type: "text", text }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather (Ukraine) MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  (globalThis as any).process?.exit?.(1);
});