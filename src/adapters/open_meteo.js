// open_meteo.js — free global weather (no key). A South-American soybean-region crop-stress
// read, powering the SA-Weather market signal ported from the co-work app (which had wanted
// paid Tomorrow.io). Emits one "markets"-class item/day; raw carries per-region detail.
//
// Stress heuristic (transparent, refine later): drier-than-normal + hotter = more stress.

import { fetchJSON } from "../util.js";

export const id = "open_meteo";
export const label = "Open-Meteo (S. American weather)";

// Key soybean-growing regions in Brazil + Argentina.
const REGIONS = [
  { name: "Mato Grosso (BR)", lat: -12.55, lon: -55.71 },
  { name: "Rio Grande do Sul (BR)", lat: -28.26, lon: -52.41 },
  { name: "Pampas (AR)", lat: -33.89, lon: -60.57 },
];

async function regionStress(r) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${r.lat}&longitude=${r.lon}` +
    `&daily=precipitation_sum,temperature_2m_max&past_days=14&forecast_days=7&timezone=auto`;
  const d = await fetchJSON(url);
  const precip = d.daily?.precipitation_sum ?? [];
  const tmax = d.daily?.temperature_2m_max ?? [];
  const precip14 = precip.slice(0, 14).reduce((a, b) => a + (b || 0), 0);
  const avgTmax = tmax.length ? tmax.reduce((a, b) => a + (b || 0), 0) / tmax.length : 0;
  const dryness = Math.max(0, Math.min(60, ((40 - precip14) / 40) * 60)); // <40mm/14d → dry
  const heat = Math.max(0, Math.min(40, ((avgTmax - 30) / 8) * 40)); // >30°C → hot
  const forecastPrecip = precip.slice(14).reduce((a, b) => a + (b || 0), 0);
  return {
    name: r.name,
    stressIndex: Math.round(dryness + heat),
    precip14mm: Math.round(precip14),
    avgTmaxC: Math.round(avgTmax * 10) / 10,
    forecast: forecastPrecip < 15 ? "dry outlook" : "rain in the forecast",
  };
}

export async function fetchItems() {
  const regions = [];
  for (const r of REGIONS) {
    try {
      regions.push(await regionStress(r));
    } catch {
      /* one region failing never kills the source */
    }
  }
  if (!regions.length) return [];
  const overallIndex = Math.round(regions.reduce((a, b) => a + b.stressIndex, 0) / regions.length);
  const worst = regions.reduce((a, b) => (b.stressIndex > a.stressIndex ? b : a));
  const date = new Date().toISOString().slice(0, 10);

  return [
    {
      uid: `${id}:sa:${date}`,
      sourceId: id,
      sourceLabel: label,
      title: `S. American soybean weather — stress index ${overallIndex}/100 (worst: ${worst.name} at ${worst.stressIndex})`,
      summary: regions.map((r) => `${r.name}: stress ${r.stressIndex}, ${r.precip14mm}mm/14d, ${r.avgTmaxC}°C, ${r.forecast}`).join(" · "),
      url: "https://open-meteo.com/",
      publishedAt: new Date().toISOString(),
      jurisdiction: "International",
      docType: "data",
      raw: { metric: "sa_weather", overallIndex, regions },
    },
  ];
}
