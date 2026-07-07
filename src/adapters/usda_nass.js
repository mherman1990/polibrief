// usda_nass.js — USDA NASS Quick Stats: latest soybean supply & price data points.
// Free key: https://quickstats.nass.usda.gov/api  → NASS_API_KEY.
//
// Not topic-driven (like email_intake/rss). Each configured query pulls one metric and
// we emit the single most-recent observation as a "markets"-class item (see SOURCE_CLASS
// in adapters/index.js) — it surfaces on the Markets tab, not the policy brief. The raw
// value/period is kept so the market-signal layer can read it later.

import { fetchJSON } from "../util.js";

export const id = "usda_nass";
export const label = "USDA NASS (supply & price)";

const BASE = "https://quickstats.nass.usda.gov/api/api_GET/";

// One metric per query. Keep these few and high-signal for Iowa soy.
const QUERIES = [
  { key: "ia-price", title: "Iowa soybean price received", unit: "$/bu",
    params: { commodity_desc: "SOYBEANS", state_alpha: "IA", statisticcat_desc: "PRICE RECEIVED" } },
  { key: "us-production", title: "U.S. soybean production", unit: "bu",
    params: { commodity_desc: "SOYBEANS", agg_level_desc: "NATIONAL", statisticcat_desc: "PRODUCTION", unit_desc: "BU" } },
  { key: "us-stocks", title: "U.S. soybean stocks", unit: "bu",
    params: { commodity_desc: "SOYBEANS", agg_level_desc: "NATIONAL", statisticcat_desc: "STOCKS", unit_desc: "BU" } },
];

// NASS records aren't pre-sorted; newest load_time (then year) wins.
function latestOf(records) {
  return [...records].sort((a, b) => {
    const t = (b.load_time || "").localeCompare(a.load_time || "");
    return t !== 0 ? t : (Number(b.year) || 0) - (Number(a.year) || 0);
  })[0];
}

export async function fetchItems({ sourceConfig = {}, env = process.env }) {
  const key = env.NASS_API_KEY;
  if (!key) throw new Error("NASS_API_KEY not set (free key: https://quickstats.nass.usda.gov/api)");
  const budget = sourceConfig.maxItemsPerRun ?? 20;
  const items = [];

  for (const q of QUERIES) {
    if (items.length >= budget) break;
    const p = new URLSearchParams({ key, format: "JSON", year__GE: String(new Date().getFullYear() - 1), ...q.params });
    let data;
    try {
      data = await fetchJSON(`${BASE}?${p}`);
    } catch {
      continue; // one bad metric never kills the source (fail-soft)
    }
    const rec = latestOf(data.data ?? []);
    if (!rec?.Value) continue;
    const period = [rec.reference_period_desc, rec.year].filter(Boolean).join(" ").trim();
    items.push({
      uid: `${id}:${q.key}:${rec.year}:${rec.reference_period_desc}`,
      sourceId: id,
      sourceLabel: label,
      title: `${q.title}: ${rec.Value} ${q.unit} (${period})`,
      summary: rec.short_desc || q.title,
      url: "https://quickstats.nass.usda.gov/",
      publishedAt: (rec.load_time ? new Date(rec.load_time.replace(" ", "T")) : new Date()).toISOString(),
      jurisdiction: rec.state_alpha === "IA" ? "Iowa" : "US",
      docType: "data",
      raw: { metric: q.key, value: rec.Value, unit: q.unit, period, shortDesc: rec.short_desc },
    });
  }
  return items;
}

// ── Timeseries (v1.5 Markets charts) ────────────────────────────────────────
// Demand/supply/price series most relevant to Iowa soybean farmers.
const NASS_SERIES = [
  { key: "nass:us:crush", label: "U.S. soybean crush", category: "soy_crush", unit: "tons/mo",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "CRUSHED", agg_level_desc: "NATIONAL" } },
  { key: "nass:us:price", label: "U.S. avg", category: "soy_price", unit: "$/bu",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "PRICE RECEIVED", agg_level_desc: "NATIONAL", unit_desc: "$ / BU" } },
  { key: "nass:ia:price", label: "Iowa avg", category: "soy_price", unit: "$/bu",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "PRICE RECEIVED", state_alpha: "IA", unit_desc: "$ / BU" } },
  { key: "nass:us:stocks", label: "U.S. soybean stocks", category: "soy_stocks", unit: "bu",
    params: { commodity_desc: "SOYBEANS", statisticcat_desc: "STOCKS", agg_level_desc: "NATIONAL", unit_desc: "BU" } },
];
const MM2 = /^(0[1-9]|1[0-2])$/;

/** Returns [{ series, meta, points }] for store.saveSeriesPoints. */
export async function fetchSeries({ env = process.env } = {}) {
  const key = env.NASS_API_KEY;
  if (!key) return [];
  const yearGE = new Date().getFullYear() - 9;
  const out = [];
  for (const s of NASS_SERIES) {
    const p = new URLSearchParams({ key, format: "JSON", year__GE: String(yearGE), ...s.params });
    let data;
    try {
      data = await fetchJSON(`${BASE}?${p}`);
    } catch {
      continue;
    }
    const pts = new Map();
    for (const r of data.data ?? []) {
      if (r.freq_desc === "ANNUAL") continue; // skip marketing-year/annual rows
      const mm = r.end_code; // NASS period-end month code, "01".."12"
      if (!MM2.test(mm)) continue;
      const val = Number(String(r.Value).replace(/,/g, ""));
      if (!Number.isFinite(val)) continue; // skips "(D)"/"(NA)" suppressed values
      pts.set(`${r.year}-${mm}`, val);
    }
    const points = [...pts.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
    if (points.length) out.push({ series: s.key, meta: { label: s.label, unit: s.unit, category: s.category }, points });
  }
  return out;
}
