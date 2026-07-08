// wasde.js — USDA WASDE (World Agricultural Supply & Demand Estimates) balance sheet.
//
// WASDE is THE monthly supply/demand number the whole market hangs on. We pull the U.S.
// soybean balance sheet — Ending Stocks and Total Use → STOCKS-TO-USE, the tightness ratio —
// plus world ending stocks. Because each monthly WASDE re-estimates the SAME marketing year,
// storing one point per release builds a "revision trail": "USDA keeps cutting carryout" is
// itself a signal.
//
// Source: USDA ESMIS machine-readable release (the old Cornell/Mann-Library feed moved to the
// National Ag Library — the cornell URL 301-redirects here). No key. "markets"-class.
//   API:   https://esmis.nal.usda.gov/api/v1/release/findByIdentifier/wasde?latest=true
//   file:  .../sites/default/release-files/<id>/wasde<MMYY>v<N>.xml
//
// The XML nests commodity → geography (matrix2 = "United States") → market year → attribute
// (Ending Stocks / Total Use) → <Cell cell_value2>. We walk it defensively rather than hard-
// coding the path, so a layout tweak doesn't silently break extraction.

import { XMLParser } from "fast-xml-parser";
import { fetchJSON, fetchText } from "../util.js";

export const id = "wasde";
export const label = "USDA WASDE (balance sheet)";

const API = "https://esmis.nal.usda.gov/api/v1/release/findByIdentifier/wasde?latest=true";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "_t" });

// Newest-first list of recent releases as { xml, date }. The ESMIS API returns
// `results[]`, each with a plain-string `files[]` and `release_datetime` — so the
// revision trail (how each month's estimate changed) is backfillable for free.
async function listReleases(limit = 6) {
  const rel = await fetchJSON(API);
  const results = rel.results || (Array.isArray(rel) ? rel : []);
  const out = [];
  for (const r of results) {
    const files = r.files || [];
    const xml = files.find((u) => /\.xml($|\?)/i.test(String(u)));
    if (xml) out.push({ xml, date: r.release_datetime || r.date || null });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error("WASDE: no .xml file URL in the ESMIS release list");
  return out;
}

// WASDE nests as: <Report sub_report_title="U.S. Soybeans and Products Supply and Use …">
//   → commodity group (commodity1|2|3 = "Soybeans" | "Soybean Meal" | "Soybean Oil")
//   → year group (market_year1|2|3) → attribute (attribute1|2|3 on an <s3>) → <Cell cell_valueN>.
// We walk the whole doc, tracking the current sub-report / commodity / year, and record every
// {attribute -> value} for the SOYBEANS commodity inside a section matching `sectionRe`.
// Returns { marketingYear -> { attribute -> number } }. Matrix-agnostic (checks the 1/2/3 variants).
function extractBalance(root, sectionRe) {
  const out = {};
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const first = (n, ...keys) => { for (const k of keys) if (n[k] != null) return n[k]; return null; };
  const V = (base) => [1, 2, 3, 4, 5, 6].map((i) => base + i);
  const getSub = (n) => first(n, "sub_report_title", "sub_report_title2", "sub_report_title3");
  const getCommodity = (n) => first(n, ...V("commodity"), "commodity");
  const getYear = (n) => first(n, ...V("market_year"));
  const getAttr = (n) => first(n, ...V("attribute"), "attribute");
  const getCell = (n) => first(n, ...V("cell_value"), "cell_value");

  let section = "", commodity = "", year = "";
  function findCell(node) {
    if (node == null || typeof node !== "object") return null;
    const c = getCell(node);
    if (c != null) { const num = Number(String(c).replace(/,/g, "")); if (Number.isFinite(num)) return num; }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) { for (const x of v) { const r = findCell(x); if (r != null) return r; } }
      else if (v && typeof v === "object") { const r = findCell(v); if (r != null) return r; }
    }
    return null;
  }
  function walk(node) {
    if (node == null || typeof node !== "object") return;
    const s0 = section, c0 = commodity, y0 = year;
    const sub = getSub(node); if (sub != null) section = norm(sub);
    const com = getCommodity(node); if (com != null) commodity = norm(com);
    const yr = getYear(node); if (yr != null) year = norm(yr);
    const at = getAttr(node);
    if (at != null && sectionRe.test(section) && /soybean/i.test(commodity) && !/meal|oil/i.test(commodity) && year) {
      const v = findCell(node);
      if (v != null) (out[year] = out[year] || {})[norm(at)] = v;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v);
    }
    section = s0; commodity = c0; year = y0;
  }
  walk(root);
  return out;
}

// Pick the marketing year to report: prefer the projection ("(Proj.)"), else the latest.
function pickYear(balance) {
  const years = Object.keys(balance);
  if (!years.length) return null;
  const proj = years.find((y) => /proj/i.test(y));
  if (proj) return proj;
  return years.sort().at(-1);
}
function attr(balance, year, re) {
  const row = balance[year] || {};
  const k = Object.keys(row).find((a) => re.test(a));
  return k ? row[k] : null;
}

async function loadRelease({ xml, date }) {
  const raw = await fetchText(xml);
  const doc = parser.parse(raw);
  const us = extractBalance(doc, /U\.?\s*S\.?\s*Soybeans/i);
  const world = extractBalance(doc, /World\s*Soybean\s*Supply/i);
  const period = date ? String(date).slice(0, 7) : new Date().toISOString().slice(0, 7);
  return { us, world, period, xml };
}

/** WASDE items → a summary of the current U.S. soybean balance sheet (markets-class). */
export async function fetchItems() {
  const [rel] = await listReleases(1);
  const { us, world, period, xml } = await loadRelease(rel);
  const y = pickYear(us);
  if (!y) return [];
  const end = attr(us, y, /ending\s*stocks/i);
  const use = attr(us, y, /total\s*use|total\s*disappearance/i);
  const stu = end != null && use ? (end / use) * 100 : null;
  const wend = attr(world, pickYear(world) || y, /ending\s*stocks/i);
  const bits = [
    end != null ? `ending stocks ${end}` : null,
    stu != null ? `stocks-to-use ${stu.toFixed(1)}%` : null,
    wend != null ? `world stocks ${wend}` : null,
  ].filter(Boolean).join(" · ");
  return [{
    uid: `wasde:us:soy:${period}`,
    sourceId: id,
    sourceLabel: label,
    title: `WASDE ${y} U.S. soybeans — ${bits || "balance sheet updated"}`,
    summary: `USDA WASDE ${period}: U.S. soybean supply/demand balance for ${y}. Stocks-to-use is the tightness ratio behind price.`,
    url: xml,
    publishedAt: new Date(`${period}-15`).toISOString(),
    jurisdiction: "US",
    docType: "data",
    raw: { marketingYear: y, endingStocks: end, totalUse: use, stocksToUse: stu, worldEndingStocks: wend },
  }];
}

/**
 * Series for the Markets charts: the revision trail — one point per monthly release, showing
 * USDA's latest projection at each point (backfilled over recent releases). Idempotent upsert,
 * so re-parsing is harmless. NOTE phase-1: plots the current projection per release; the target
 * marketing year rolls at the May new-crop WASDE (a fixed-year trail is a phase-2 refinement).
 */
export async function fetchSeries() {
  const releases = await listReleases(8);
  const loaded = (await Promise.allSettled(releases.map(loadRelease)))
    .filter((r) => r.status === "fulfilled").map((r) => r.value);
  const endPts = [], stuPts = [], wendPts = [];
  for (const { us, world, period } of loaded) {
    const y = pickYear(us);
    if (y) {
      const end = attr(us, y, /ending\s*stocks/i);
      const use = attr(us, y, /total\s*use|total\s*disappearance/i);
      if (end != null) endPts.push({ period, value: end });
      if (end != null && use) stuPts.push({ period, value: (end / use) * 100 });
    }
    const wy = pickYear(world);
    const wend = wy ? attr(world, wy, /ending\s*stocks/i) : null;
    if (wend != null) wendPts.push({ period, value: wend });
  }
  const out = [];
  if (endPts.length) out.push({ series: "wasde:us:soy-endstocks", meta: { label: "U.S. soybean ending stocks", unit: "mln", category: "soy_balance" }, points: endPts });
  if (wendPts.length) out.push({ series: "wasde:world:soy-endstocks", meta: { label: "World soybean ending stocks", unit: "mln", category: "soy_balance" }, points: wendPts });
  if (stuPts.length) out.push({ series: "wasde:us:soy-stocks-to-use", meta: { label: "U.S. soybean stocks-to-use", unit: "%", category: "soy_balance_stu" }, points: stuPts });
  return out;
}
