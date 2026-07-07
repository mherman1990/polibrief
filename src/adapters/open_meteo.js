// open_meteo.js — free global weather (no key). A soybean-growing-region crop-stress read
// for BOTH the U.S. Corn Belt (Iowa + neighbors — the domestic yield signal) and South
// America (Brazil/Argentina — the competitor-supply signal). Emits one "markets"-class item
// per region-group/day; raw carries per-region detail.
//
// Stress heuristic (transparent, refine later): drier-than-normal + hotter = more stress.
// A true climatology-based anomaly needs normals (e.g. PRISM) — deferred; these fixed
// thresholds are a usable current-conditions gauge in the meantime.

import { fetchJSON } from "../util.js";

export const id = "open_meteo";
export const label = "Open-Meteo (crop weather)";

// Key U.S. soybean-growing regions (Iowa-centric).
const US_REGIONS = [
  { name: "Central Iowa", lat: 41.88, lon: -93.6 },
  { name: "NW Iowa", lat: 43.0, lon: -95.6 },
  { name: "SE Iowa", lat: 41.0, lon: -91.5 },
  { name: "Illinois", lat: 40.0, lon: -89.0 },
  { name: "Minnesota", lat: 44.5, lon: -94.5 },
];

// Key soybean-growing regions in Brazil + Argentina (competitor supply).
const SA_REGIONS = [
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

/** Build one aggregated crop-weather item for a group of regions, or null if all failed. */
async function groupItem(regions, scopeLabel, metricTag, jurisdiction) {
  const results = [];
  for (const r of regions) {
    try {
      results.push(await regionStress(r));
    } catch {
      /* one region failing never kills the group */
    }
  }
  if (!results.length) return null;
  const overallIndex = Math.round(results.reduce((a, b) => a + b.stressIndex, 0) / results.length);
  const worst = results.reduce((a, b) => (b.stressIndex > a.stressIndex ? b : a));
  const date = new Date().toISOString().slice(0, 10);
  return {
    uid: `${id}:${metricTag}:${date}`,
    sourceId: id,
    sourceLabel: label,
    title: `${scopeLabel} soybean weather — stress index ${overallIndex}/100 (worst: ${worst.name} at ${worst.stressIndex})`,
    summary: results.map((r) => `${r.name}: stress ${r.stressIndex}, ${r.precip14mm}mm/14d, ${r.avgTmaxC}°C, ${r.forecast}`).join(" · "),
    url: "https://open-meteo.com/",
    publishedAt: new Date().toISOString(),
    jurisdiction,
    docType: "data",
    raw: { metric: metricTag, overallIndex, regions: results },
  };
}

export async function fetchItems() {
  const items = [];
  const us = await groupItem(US_REGIONS, "U.S. Corn Belt", "us_weather", "US");
  if (us) items.push(us);
  const sa = await groupItem(SA_REGIONS, "S. American", "sa", "International");
  if (sa) items.push(sa);
  return items;
}
