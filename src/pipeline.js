// pipeline.js — the full run (fetch → score → triage → brief → deliver),
// plus `query` and `audit`. Used by both the CLI (index.js) and the web
// server's built-in scheduler (server.js).

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

import * as store from "./store.js";
import { collectAll } from "./collect.js";
import { scoreItems } from "./score.js";
import { triageItems } from "./triage.js";
import { generateBrief } from "./brief.js";
import { saveBrief, postToTeams, sendEmail } from "./deliver.js";
import { adapters, classOf, sourceIdsForClass } from "./adapters/index.js";
import { syncRegistryFromSeed } from "./registry.js";
import { EDUCATION_SYSTEM_PROMPT, seedCurriculum } from "./curriculum.js";

/** The live watchlist file: the data-volume copy in Docker/Umbrel, else the project one. */
export function watchlistFilePath() {
  const candidates = [path.join(store.DATA_DIR, "watchlist.json"), path.join(store.PROJECT_ROOT, "watchlist.json")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`Could not find watchlist.json (looked in ${candidates.join(" and ")})`);
  }
  return found;
}

// --- Focus areas -----------------------------------------------------------
// The watchlist is organized into FOCUS AREAS (issue buckets the analyst thinks
// in). Each has a single flat `terms` list used BOTH to search sources and to
// score/tag items, plus an `appliesTo` list of source ids. The collect/score/
// triage engine still consumes the older per-topic shape, so we derive that view
// on load (deriveEngineTopics) and strip it again on save.

/** All known source ids — a focus area with no `appliesTo` applies to all of them. */
const ALL_SOURCE_IDS = Object.keys(adapters);

/** Convert a legacy "topics" array (keywords + per-source queries) into focus areas. */
function migrateTopicsToFocusAreas(topics) {
  return (topics ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    weight: t.weight ?? 5,
    enabled: t.enabled !== false,
    terms: [...new Set([...(t.keywords ?? []), ...Object.values(t.queries ?? {}).flat()])],
    appliesTo: [...ALL_SOURCE_IDS],
  }));
}

/**
 * The engine (collect/score/triage/adapters) consumes a topic shape:
 *   { id, label, weight, keywords, queries: { [sourceId]: string[] } }
 * Derive it from focus areas — the flat `terms` list serves as both keywords
 * (scoring) and per-source queries (collection), for every source it applies to.
 */
function deriveEngineTopics(focusAreas) {
  return (focusAreas ?? [])
    .filter((fa) => fa.enabled !== false)
    .map((fa) => {
      const applies = fa.appliesTo && fa.appliesTo.length ? fa.appliesTo : ALL_SOURCE_IDS;
      const terms = fa.terms ?? [];
      const queries = {};
      for (const sid of applies) queries[sid] = terms;
      return { id: fa.id, label: fa.label, weight: fa.weight ?? 5, keywords: terms, queries };
    });
}

/** Ensure focusAreas exist (migrating legacy topics) and attach the derived engine view. */
export function normalizeWatchlist(w) {
  if (!Array.isArray(w.focusAreas) || w.focusAreas.length === 0) {
    w.focusAreas =
      Array.isArray(w.topics) && w.topics.length ? migrateTopicsToFocusAreas(w.topics) : w.focusAreas ?? [];
  }
  w.topics = deriveEngineTopics(w.focusAreas); // engine view; stripped again on save
  return w;
}

/** Persist watchlist edits from the web UI. The derived engine `topics` view is never written. */
export function saveWatchlist(watchlist) {
  const { topics, ...persist } = watchlist; // drop the derived engine view before writing
  void topics;
  fs.writeFileSync(watchlistFilePath(), JSON.stringify(persist, null, 2) + "\n", "utf8");
}

export function loadWatchlist() {
  const watchlistPath = watchlistFilePath();
  let text;
  try {
    // strip a UTF-8 BOM if present — Windows Notepad/PowerShell add one, and JSON.parse rejects it
    text = fs.readFileSync(watchlistPath, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new Error(`Could not read ${watchlistPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `watchlist.json is not valid JSON: ${err.message}\n   Tip: check for a missing comma or quote, or paste the file into jsonlint.com`
    );
  }
  return normalizeWatchlist(parsed);
}

function printScoredTable(kept, dropped) {
  if (kept.length === 0) {
    console.log("   (no items passed the local filter)");
    return;
  }
  const rows = kept.map((item) => ({
    score: item.localScore,
    source: item.sourceId,
    juris: item.jurisdiction,
    topics: item.matchedTopics.map((t) => t.id).join(", ") || "—",
    title: item.title.length > 70 ? item.title.slice(0, 67) + "..." : item.title,
  }));
  console.table(rows);
  console.log(`   (${dropped} below threshold or over cap — dropped locally, cost $0)`);
}

/** The whole show: fetch → score → (triage → brief → deliver unless dry run). */
/**
 * Refresh market timeseries (for the Markets charts) from every adapter that exposes a
 * fetchSeries() — idempotent upsert into store.market_series. Fail-soft per adapter.
 */
export async function refreshMarketSeries(env = process.env) {
  let seriesCount = 0;
  for (const adapter of Object.values(adapters)) {
    if (typeof adapter.fetchSeries !== "function") continue;
    try {
      const list = await adapter.fetchSeries({ env });
      for (const s of list) {
        store.saveSeriesPoints(s.series, s.meta, s.points);
        seriesCount++;
      }
      if (list.length) console.log(`📈 ${adapter.label}: refreshed ${list.length} market series`);
    } catch (err) {
      console.log(`⚠️  ${adapter.label} series refresh failed: ${err.message}`);
    }
  }
  return seriesCount;
}

export async function runPipeline({ edition = "am", dryRun = false, source = null, env = process.env }) {
  const watchlist = loadWatchlist();

  console.log(`\n🌱 The Bean Brief ${dryRun ? "(dry run — no Anthropic calls)" : `— ${edition} edition`}\n`);

  // Keep the entity registry current so entity-driven adapters (rss/email-intake)
  // have their channels even on a bare CLI/cron run (the server also syncs on startup).
  // Idempotent; also means registry.json edits apply on the next run, no restart needed.
  try {
    const r = syncRegistryFromSeed();
    if (r.entities) console.log(`🗂️  Registry: ${r.entities} entities, ${r.channels} channels synced`);
  } catch (err) {
    console.log(`⚠️  Registry sync skipped: ${err.message}`);
  }

  // 1. Collect. Dry runs never write state (no last-success advance, no items marked seen).
  const { items, skippedSources, fetchedCount } = await collectAll({
    watchlist,
    env,
    onlySource: source,
    commit: !dryRun,
  });

  // 1b. Split by information class. Only "official" (regulatory/legal) sources feed the
  // policy pipeline (score → triage → brief). "news" (collector/press) and "markets"
  // (demand data) items are stored for their own tabs but NEVER enter the policy brief —
  // that's what keeps the Items/brief flow clean even when they hit a policy keyword
  // (e.g. EIA "soybean oil → biodiesel" would otherwise match the biofuels area).
  const officialItems = [];
  const sideItems = [];
  for (const it of items) (classOf(it.sourceId) === "official" ? officialItems : sideItems).push(it);
  if (!dryRun && sideItems.length) {
    for (const it of sideItems) store.markSeen(it, null);
    console.log(`🗂️  Stored ${sideItems.length} news/markets item${sideItems.length === 1 ? "" : "s"} for their tabs (kept out of the brief).`);
  }

  // 1c. Refresh market timeseries (Markets charts) from any adapter exposing fetchSeries.
  if (!dryRun) await refreshMarketSeries(env);

  // 2. Local scoring — free, runs before Claude sees anything.
  console.log(`\n🔎 Scoring ${officialItems.length} new item${officialItems.length === 1 ? "" : "s"}…`);
  const { kept, dropped } = scoreItems(officialItems, watchlist.topics ?? [], watchlist.output);
  console.log(`   ${kept.length} pass the local filter (min score ${watchlist.output?.minLocalScoreForTriage ?? 5})`);

  if (dryRun) {
    printScoredTable(kept, dropped);
    if (skippedSources.length > 0) {
      console.log(`\n⚠️  Skipped sources: ${skippedSources.map((s) => s.label).join(", ")}`);
    }
    console.log("\n✅ Dry run complete — nothing was saved, no Anthropic calls were made.\n");
    return { dryRun: true, kept, skippedSources };
  }

  return runFullPipeline({ watchlist, env, edition, kept, items: officialItems, skippedSources, fetchedCount });
}

// Rough list prices per 1M tokens, for the audit cost estimate only.
// Update if Anthropic pricing changes — this affects nothing but the printout.
const PRICES = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
};

export async function runFullPipeline({ watchlist, env, edition, kept, items, skippedSources, fetchedCount }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com (or use --dry-run to test without it)");
  }

  // 3. Haiku triage on the locally-filtered survivors.
  console.log(`\n🤖 Triage (${env.TRIAGE_MODEL || "claude-haiku-4-5"}): sending ${kept.length} item${kept.length === 1 ? "" : "s"}…`);
  const { relevant } = await triageItems(kept, watchlist.topics ?? [], env);
  console.log(`   ${relevant.length} relevant`);

  // 3b. Flag movement on tracked items (pinned in the web UI) — these always
  // make the brief and get their own 📌 section.
  const trackedKeys = store.trackedKeySet();
  if (trackedKeys.size > 0) {
    for (const item of relevant) {
      const stableKey = item.raw?.billId ? `legiscan-bill:${item.raw.billId}` : item.uid;
      item.tracked = trackedKeys.has(stableKey) || trackedKeys.has(item.uid);
    }
    const moved = relevant.filter((i) => i.tracked).length;
    if (moved > 0) console.log(`   📌 ${moved} tracked item${moved === 1 ? "" : "s"} with new activity`);
  }

  // Anything fetched but not triaged (dropped by local scoring) is still recorded
  // as seen, so it is never re-processed. Core cost-discipline rule.
  const keptUids = new Set(kept.map((i) => i.uid));
  for (const item of items) {
    if (!keptUids.has(item.uid)) store.markSeen(item, null);
  }

  // 4. Sonnet brief.
  const stats = {
    fetchedCount,
    sourceCount: Object.keys(adapters).filter((s) => watchlist.sources?.[s]?.enabled).length,
    skippedSources,
  };
  if (relevant.length > 0) {
    console.log(`\n📝 Generating brief (${env.BRIEF_MODEL || "claude-sonnet-4-6"})…`);
  } else {
    console.log("\n📝 Nothing relevant today — writing a short no-news brief (no Sonnet call needed)");
  }
  const markdown = await generateBrief({ relevantItems: relevant, watchlist, edition, env, stats });

  // 5. Deliver.
  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";
  const filePath = saveBrief(markdown, edition, timezone);
  let deliveredTo = [path.relative(store.DATA_DIR, filePath)];

  if (watchlist.output?.teams !== false) {
    try {
      if (await postToTeams(markdown, env)) deliveredTo.push("Teams");
    } catch (err) {
      console.log(`⚠️  Teams delivery failed: ${err.message}`);
    }
  }
  try {
    if (await sendEmail(markdown, edition, env, watchlist)) deliveredTo.push("email");
  } catch (err) {
    console.log(`⚠️  Email delivery failed: ${err.message}`);
  }

  // 5b. (Retired) The twice-daily farmer twin used to render here on every run. It's been
  // replaced by the on-demand "farmer" memo preset (generateMemo) — same audience, but
  // generated when asked over a chosen window, so the scheduled run never pays for it.

  console.log(`\n✅ Saved ${deliveredTo.join(" · posted to ")}\n`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Render the deep trend snapshot as compact, category-grouped lines — latest + change,
 * year-over-year, historical range/percentile, and a seasonal read — so the model can
 * teach trends (is this seasonally normal? how does it compare to years past?) from the
 * full history we store, not just the latest number.
 */
function formatMarketSnapshot(snapshot) {
  if (!snapshot || snapshot.length === 0) return "";
  const fmt = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(Number(v).toFixed(2))));
  const pct = (v) => (v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  const byCat = new Map();
  for (const s of snapshot) {
    const cat = s.category || "other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(s);
  }
  const lines = [];
  for (const [cat, list] of byCat) {
    lines.push(`# ${cat}`);
    for (const s of list) {
      const parts = [`${fmt(s.latest.value)} ${s.unit} (${s.latest.period})`];
      if (s.changePct != null) parts.push(`Δ ${pct(s.changePct)} vs prior`);
      if (s.yoyPct != null) parts.push(`YoY ${pct(s.yoyPct)}`);
      parts.push(`range ${fmt(s.min.value)}–${fmt(s.max.value)}, now ${s.percentile}th pctile of ${s.count} obs since ${s.firstPeriod}`);
      if (s.seasonalDeltaPct != null) {
        const mon = MONTHS[(Number(s.latest.period.slice(5, 7)) || 1) - 1];
        parts.push(`seasonal ${pct(s.seasonalDeltaPct)} vs ${mon} avg (${s.seasonalPctile}th pctile for ${mon})`);
      }
      let line = `- ${s.label}: ${parts.join("; ")}`;
      if (s.trail && s.trail.length > 1) line += ` — recent: ${s.trail.map((p) => fmt(p.value)).join(" → ")}`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

/** Project stored item rows to a compact, uniform shape for the LLM context. */
function compactItems(rows) {
  return rows.map((h) => ({
    title: h.title,
    url: h.url,
    source: h.source_id,
    jurisdiction: h.jurisdiction,
    why: h.one_line,
    verdict: h.triage_verdict,
    seen: (h.first_seen_at || "").slice(0, 10),
  }));
}

/**
 * The master query engine: answer a question by retrieving across EVERY pipeline —
 * Laws/Rules/Decisions + News items, the demand-side MARKET timeseries, tracked items,
 * upcoming comment deadlines, and recent briefs — then one Sonnet call to synthesize
 * with citations. Shared by the CLI (`query`) and the homepage "Ask the Bean Brief" box.
 * @returns {{ answer: string, hits: object[] }}
 */
export async function answerQuery(question, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }

  // 1. Stored items (LRD + News). Keyword hits on the phrase, a per-word fallback if the
  //    phrase found nothing, and the most recent relevant items UNIONed in so recency
  //    questions ("what's new this week?") work even without a keyword match.
  const itemHits = store.searchSeenItems(question);
  const extraHits =
    itemHits.length === 0
      ? question.split(/\s+/).filter((w) => w.length > 3).flatMap((w) => store.searchSeenItems(w, 10))
      : [];
  const recent = store.listItems({ verdict: "relevant", days: 30, limit: 20 });
  const merged = [...new Map([...itemHits, ...extraHits, ...recent].map((h) => [h.uid, h])).values()].slice(0, 30);
  const compactHits = compactItems(merged);

  // 2. Market data — the structured demand-side timeseries (price, crush, stocks, biofuel
  //    feedstock share, basis, fund positioning…). This is what makes the DATA queryable
  //    in plain English, not just visible as charts.
  const marketBlock = formatMarketSnapshot(store.marketSnapshot());

  // 3. Tracked (pinned) items + upcoming comment deadlines.
  const tracked = store.listTracked();
  const deadlines = store.upcomingDeadlines(20);

  // 4. Most recent few briefs as narrative context.
  const briefTexts = [];
  for (const b of store.listBriefs(4)) {
    const p = path.join(store.DATA_DIR, b.path);
    if (fs.existsSync(p)) briefTexts.push(`--- Brief ${b.path} ---\n${fs.readFileSync(p, "utf8").slice(0, 6000)}`);
  }

  if (compactHits.length === 0 && !marketBlock && briefTexts.length === 0) {
    return { answer: "Nothing stored yet matches. Run the pipeline a few times first.", hits: [] };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-4-6";
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system:
      "You are the research assistant for a professional at the Iowa Soybean Association whose remit is BOTH policy and demand/markets. Answer using ONLY the stored monitoring data provided below, which spans three streams: (1) LAWS/RULES/DECISIONS + NEWS items, (2) MARKET DATA (soybean price, crush, stocks, biofuel feedstock share, basis, fund positioning, exports, barge freight, crop condition, weather), and (3) recent BRIEFS, plus tracked items and comment deadlines. The market data carries trend context per series — change vs. prior, year-over-year, the historical range with the latest value's percentile, and a seasonal read (vs. the same month across years). USE that context to explain trends and whether a value is seasonally normal or unusual, not just the latest number. Synthesize across streams when it helps — e.g. connect a policy or trade development to the market numbers. Cite item titles as markdown links when a URL is available; when you cite a market figure, name the series and its period (e.g. \"U.S. crush 210M bu, Apr 2026\"). Use plain, professional English. If the stored data doesn't answer the question, say so plainly rather than guessing.",
    messages: [
      {
        role: "user",
        content:
          `Question: ${question}\n\n` +
          `=== MARKET DATA (latest value, change vs prior, recent trail) ===\n${marketBlock || "(no market data stored yet)"}\n\n` +
          `=== LAWS/RULES/DECISIONS + NEWS items (JSON) ===\n${JSON.stringify(compactHits, null, 1)}\n\n` +
          `=== TRACKED ITEMS (pinned) ===\n${tracked.length ? tracked.map((t) => `- ${t.title}${t.jurisdiction ? ` (${t.jurisdiction})` : ""}${t.url ? ` ${t.url}` : ""}`).join("\n") : "(none)"}\n\n` +
          `=== UPCOMING COMMENT DEADLINES ===\n${deadlines.length ? deadlines.map((d) => `- ${d.comment_deadline}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n") : "(none)"}\n\n` +
          `=== RECENT BRIEFS ===\n${briefTexts.join("\n\n") || "(none)"}`,
      },
    ],
  });
  store.recordUsage(model, "query", response.usage.input_tokens, response.usage.output_tokens);
  return { answer: response.content.find((b) => b.type === "text")?.text ?? "(no answer)", hits: merged };
}

export async function runQuery(question, env) {
  console.log(`\n🔍 Searching stored briefs and items for: "${question}"…`);
  const { answer } = await answerQuery(question, env);
  console.log("\n" + answer + "\n");
}

// --- Memo mode ------------------------------------------------------------
// A "memo" is the master query engine run in report mode: the same cross-stream
// retrieval (items + market data + tracked + deadlines + briefs), but scoped to a
// time window and prompted to WRITE a structured memo for a given audience instead
// of answering a question. Weekly/monthly reports and the on-demand farmer update
// are all presets of this one engine — no separate feature per report type.
export const MEMO_PRESETS = {
  weekly: {
    label: "Weekly memo",
    edition: "weekly",
    scopeDays: 7,
    maxTokens: 6000,
    system: (dateLabel) => `You write The Bean Brief's WEEKLY policy & market memo for Iowa Soybean Association colleagues and board members who did not follow the daily flow. Use ONLY the stored monitoring data provided (laws/rules/decisions + news items, the market timeseries, tracked items, comment deadlines, recent briefs). Structure exactly:

## The Bean Brief — Weekly Memo (week ending ${dateLabel})

### The week in three sentences
### 📈 Markets & demand
What the market data did this week — crush, soybean & soy-oil prices, biofuel feedstock share, basis, fund positioning — with the numbers (name the series + period).
### 🏛️ Policy & regulatory
What changed in laws/rules/decisions and why it matters to Iowa soy.
### 🔴 What needs attention next week
Comment deadlines approaching, votes scheduled, rules expected.
### 📋 Everything else worth knowing
One line each.

Rules: never invent items or numbers; keep every markdown link; cite a market figure with its series + period; plain professional English; omit empty sections.`,
  },
  monthly: {
    label: "Monthly review",
    edition: "monthly",
    scopeDays: 30,
    maxTokens: 6000,
    system: (dateLabel) => `You write The Bean Brief's MONTHLY policy & market review for Iowa Soybean Association leadership — a higher-altitude "month in review," trends over the month, not a day-by-day list. Use ONLY the stored monitoring data provided. Structure exactly:

## The Bean Brief — Monthly Review (as of ${dateLabel})

### The month in five sentences
### 📈 Markets & demand — the trend
Where crush, prices, biofuel feedstock demand, basis and positioning moved over the month, with the numbers (name the series + period).
### 🏛️ Policy & regulatory — what shifted
The month's meaningful rule/bill/court developments and their direction of travel.
### 🔭 What we're watching
Comment deadlines, expected rules, decisions on the horizon.
### 📋 Notable items
One line each.

Rules: never invent items or numbers; keep every markdown link; cite a market figure with its series + period; plain professional English; omit empty sections.`,
  },
  farmer: {
    label: "Farmer update",
    edition: "farmer",
    scopeDays: 7,
    maxTokens: 3000,
    system: (dateLabel) => `You write "The Bean Brief for Farmers" — a plain-language, strictly NONPARTISAN update for Iowa Soybean Association farmer-members (not policy insiders). Use ONLY the stored monitoring data. Explain what each development MEANS for a soybean farmer's bottom line — prices, demand, input costs, rules that touch their operation. Structure exactly:

## The Bean Brief for Farmers — ${dateLabel}

### 💵 Markets: what your beans are worth
Cash price + basis (name the number and date), crush/demand direction, biofuel demand — in plain terms.
### 🏛️ Policy you should know about
2–4 items max, plain English, why it matters to your farm.
### 📅 Dates to know
Comment deadlines or decisions that affect farmers.

Rules: never invent items or numbers; keep markdown links; nonpartisan and informational ONLY — no advocacy, no "contact your legislator," no partisan framing; keep it short — a farmer reads this in two minutes.`,
  },
  education: {
    label: "Market-education brief",
    edition: "education",
    scopeDays: 3,
    maxTokens: 2200,
    injectCurriculum: true,
    // The stable "teach, don't tell" identity (§1) + the daily-brief task structure (§3).
    system: (dateLabel) => `${EDUCATION_SYSTEM_PROMPT}

TASK: Write today's BeanBrief daily market-education brief for Iowa soybean and corn farmers, using ONLY the data context provided. Structure exactly:

## BeanBrief — Market Education, ${dateLabel}

### The lead
2–3 sentences: what mattered most in the market lately and — the important part — WHY. Anchor to the most significant data point. If a move was driven by a surprise vs. expectations, teach that.
### What moved
2–4 short items. Each: the fact (with source + date), then one or two sentences of plain explanation of the mechanism. Skip anything that doesn't help understanding today.
### Understanding today's market
One short paragraph teaching the assigned CONCEPT (provided below), tied to something in today's data so the lesson lands in context. Treat this as the most valuable part.
### Worth watching
1–2 bullets: what a farmer can now watch for themselves — the next report, a weather window, an export pace. "Here's what to watch and why," never "here's what to do."
### Today's terms
A one-line plain definition for any market term you used (draw from the glossary provided). Omit this block entirely if you introduced no term.

Length: scannable in ~90 seconds (250–400 words). No preamble, no sign-off. Start at the lead. Remember the hard guardrails — explain, never advise.`,
  },
};

/**
 * Generate a memo from a preset — the master query engine in report mode. Retrieves
 * across all streams scoped to the preset's window, one Sonnet call, saved as
 * YYYY-MM-DD-<edition>.md (so it lists on the homepage and renders at /brief/…).
 * @returns {{ markdown: string, filePath: string, edition: string }}
 */
export async function generateMemo(presetId, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }
  const preset = MEMO_PRESETS[presetId];
  if (!preset) {
    throw new Error(`Unknown memo preset "${presetId}" — choose one of: ${Object.keys(MEMO_PRESETS).join(", ")}`);
  }

  const watchlist = loadWatchlist();
  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

  // Retrieve across all streams, scoped to the preset's window (memo mode).
  // Official items are triaged (verdict=relevant); news items are never triaged
  // (verdict=unscored) so we pull them by class rather than by verdict.
  const official = store.listItems({ verdict: "relevant", days: preset.scopeDays, sourceIds: sourceIdsForClass("official"), limit: 50 });
  const news = store.listItems({ days: preset.scopeDays, sourceIds: sourceIdsForClass("news"), limit: 30 });
  const compactHits = compactItems([...official, ...news]);
  const marketBlock = formatMarketSnapshot(store.marketSnapshot());
  const tracked = store.listTracked();
  const deadlines = store.upcomingDeadlines(20);

  // Daily briefs within the window (never fold memos back into memos).
  const cutoff = Date.now() - preset.scopeDays * 86400e3;
  const briefTexts = [];
  for (const b of store.listBriefs(40)) {
    if (Date.parse(b.created_at) < cutoff) continue;
    if (/-(weekly|monthly|farmer)\.md$/.test(b.path)) continue;
    const p = path.join(store.DATA_DIR, b.path);
    if (fs.existsSync(p)) briefTexts.push(`--- ${path.basename(b.path)} ---\n${fs.readFileSync(p, "utf8").slice(0, 9000)}`);
  }

  // For the education brief: inject a season-aware teaching concept (+ glossary). Auto-seed
  // the concept bank if it's empty so this works even before `seed-curriculum` is run.
  let curriculumBlock = "";
  if (preset.injectCurriculum) {
    if (store.listConcepts().length === 0) seedCurriculum();
    const concept = store.pickConcept();
    const glossary = store.getGlossary();
    curriculumBlock =
      `\n\n=== ASSIGNED TEACHING CONCEPT (explain this in "Understanding today's market") ===\n` +
      (concept ? `${concept.title}\n${concept.body}` : "(none)") +
      `\n\n=== GLOSSARY (for "Today's terms") ===\n` +
      (glossary.length ? glossary.map((g) => `- ${g.term}: ${g.definition}`).join("\n") : "(none)");
    if (concept) console.log(`   🎓 teaching concept: ${concept.id}`);
  }

  const model = env.BRIEF_MODEL || "claude-sonnet-4-6";
  console.log(`\n📝 ${preset.label}: ${official.length + news.length} items + ${marketBlock ? "market data" : "no market data"} over the last ${preset.scopeDays}d (${model})…`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: preset.maxTokens,
    system: preset.system(dateLabel),
    messages: [
      {
        role: "user",
        content:
          `Stored monitoring data for the last ${preset.scopeDays} days — write the memo per your instructions.\n\n` +
          `=== MARKET DATA (latest value, change vs prior, recent trail) ===\n${marketBlock || "(no market data stored yet)"}\n\n` +
          `=== LAWS/RULES/DECISIONS + NEWS items (JSON) ===\n${JSON.stringify(compactHits, null, 1)}\n\n` +
          `=== TRACKED ITEMS (pinned) ===\n${tracked.length ? tracked.map((t) => `- ${t.title}${t.jurisdiction ? ` (${t.jurisdiction})` : ""}${t.url ? ` ${t.url}` : ""}`).join("\n") : "(none)"}\n\n` +
          `=== UPCOMING COMMENT DEADLINES ===\n${deadlines.length ? deadlines.map((d) => `- ${d.comment_deadline}: ${d.title}${d.url ? ` ${d.url}` : ""}`).join("\n") : "(none)"}\n\n` +
          `=== DAILY BRIEFS IN WINDOW ===\n${briefTexts.join("\n\n") || "(none)"}` +
          curriculumBlock,
      },
    ],
  });
  store.recordUsage(model, "memo", response.usage.input_tokens, response.usage.output_tokens);
  const markdown = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  const filePath = saveBrief(markdown, preset.edition, timezone);
  return { markdown, filePath, edition: preset.edition };
}

/** Generate + save a memo preset (CLI + web + scheduler entry point). */
export async function runMemo(presetId, env) {
  const { filePath } = await generateMemo(presetId, env);
  console.log(`\n✅ Saved ${path.relative(store.DATA_DIR, filePath)}\n`);
}

/** The Friday weekly memo — now a preset of the memo engine (kept for the scheduler + CLI). */
export async function runWeekly(env) {
  return runMemo("weekly", env);
}

export async function runAudit() {
  const { sourceCounts, lastRuns, monthUsage, briefCount } = store.getAuditData();

  console.log("\n📊 polibrief audit\n");
  console.log("Per-source items seen:");
  if (sourceCounts.length === 0) console.log("   (none yet — run the pipeline first)");
  for (const row of sourceCounts) {
    console.log(`   ${row.source_id.padEnd(18)} ${String(row.total).padStart(5)} seen, ${String(row.relevant ?? 0).padStart(4)} relevant`);
  }

  console.log("\nLast successful fetch:");
  if (lastRuns.length === 0) console.log("   (no completed runs yet)");
  for (const row of lastRuns) {
    console.log(`   ${row.source_id.padEnd(18)} ${row.last_success_at}`);
  }

  console.log(`\nBriefs saved: ${briefCount}`);

  console.log("\nAnthropic usage this month:");
  if (monthUsage.length === 0) console.log("   (no Anthropic calls yet)");
  let totalCost = 0;
  for (const row of monthUsage) {
    const price = PRICES[row.model] ?? { input: 3.0, output: 15.0 };
    const cost = (row.input_tokens / 1e6) * price.input + (row.output_tokens / 1e6) * price.output;
    totalCost += cost;
    console.log(
      `   ${row.model.padEnd(20)} ${String(row.calls).padStart(4)} calls, ` +
        `${String(row.input_tokens).padStart(9)} in / ${String(row.output_tokens).padStart(8)} out tokens ≈ $${cost.toFixed(2)}`
    );
  }
  if (monthUsage.length > 0) console.log(`   ${"".padEnd(20)} estimated month-to-date total ≈ $${totalCost.toFixed(2)}`);
  console.log();
}
