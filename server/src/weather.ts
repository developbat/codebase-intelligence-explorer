const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
  55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Freezing drizzle",
  61: "Slight rain", 63: "Rain", 65: "Heavy rain", 66: "Light freezing rain",
  67: "Freezing rain", 71: "Slight snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Slight rain showers", 81: "Rain showers",
  82: "Violent rain showers", 85: "Slight snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
};

async function fetchJson(url: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "B.A.D-IDE/1.0" },
    });
    if (!response.ok) throw new Error(`Weather service returned HTTP ${response.status}.`);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export interface WeatherReport {
  location: { name: string; country?: string; latitude: number; longitude: number; timezone?: string };
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  wind: number;
  condition: string;
  weatherCode: number;
  units: "celsius" | "fahrenheit";
  observedAt?: string;
}

export async function getWeather(
  location: string,
  units: "celsius" | "fahrenheit" = "celsius",
): Promise<WeatherReport> {
  const place = location.trim();
  if (!place) throw new Error("A city or place is required.");
  const geo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
  );
  const results = Array.isArray(geo.results) ? geo.results : [];
  const first = results[0] as Record<string, unknown> | undefined;
  if (!first || typeof first.latitude !== "number" || typeof first.longitude !== "number") {
    throw new Error(`No location found for "${place}".`);
  }
  const forecast = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${first.latitude}&longitude=${first.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&temperature_unit=${units === "fahrenheit" ? "fahrenheit" : "celsius"}` +
      `&wind_speed_unit=${units === "fahrenheit" ? "mph" : "kmh"}&timezone=auto`,
  );
  const current = forecast.current as Record<string, unknown> | undefined;
  if (!current || typeof current.temperature_2m !== "number") {
    throw new Error("Weather service returned no current conditions.");
  }
  const code = Number(current.weather_code) || 0;
  return {
    location: {
      name: String(first.name ?? place),
      country: first.country ? String(first.country) : undefined,
      latitude: first.latitude,
      longitude: first.longitude,
      timezone: typeof forecast.timezone === "string" ? forecast.timezone : undefined,
    },
    temperature: current.temperature_2m,
    apparentTemperature: Number(current.apparent_temperature) || current.temperature_2m,
    humidity: Number(current.relative_humidity_2m) || 0,
    wind: Number(current.wind_speed_10m) || 0,
    condition: WEATHER_CODES[code] ?? `Weather code ${code}`,
    weatherCode: code,
    units,
    observedAt: typeof current.time === "string" ? current.time : undefined,
  };
}
