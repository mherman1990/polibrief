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
import { adapters } from "./adapters/index.js";

/** The live watchlist file: the data-volume copy in Docker/Umbrel, else the project one. */
export function watchlistFilePath() {
  const candidates = [path.join(store.DATA_DIR, "watchlist.json"), path.join(store.PROJECT_ROOT, "watchlist.json")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`Could not find watchlist.json (looked in ${candidates.join(" and ")})`);
  }
  return found;
}

/** Persist watchlist edits made from the web UI. */
export function saveWatchlist(watchlist) {
  fs.writeFileSync(watchlistFilePath(), JSON.stringify(watchlist, null, 2) + "\n", "utf8");
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
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `watchlist.json is not valid JSON: ${err.message}\n   Tip: check for a missing comma or quote, or paste the file into jsonlint.com`
    );
  }
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
export async function runPipeline({ edition = "am", dryRun = false, source = null, env = process.env }) {
  const watchlist = loadWatchlist();

  console.log(`\n🌱 polibrief ${dryRun ? "(dry run — no Anthropic calls)" : `— ${edition} edition`}\n`);

  // 1. Collect. Dry runs never write state (no last-success advance, no items marked seen).
  const { items, skippedSources, fetchedCount } = await collectAll({
    watchlist,
    env,
    onlySource: source,
    commit: !dryRun,
  });

  // 2. Local scoring — free, runs before Claude sees anything.
  console.log(`\n🔎 Scoring ${items.length} new item${items.length === 1 ? "" : "s"}…`);
  const { kept, dropped } = scoreItems(items, watchlist.topics ?? [], watchlist.output);
  console.log(`   ${kept.length} pass the local filter (min score ${watchlist.output?.minLocalScoreForTriage ?? 5})`);

  if (dryRun) {
    printScoredTable(kept, dropped);
    if (skippedSources.length > 0) {
      console.log(`\n⚠️  Skipped sources: ${skippedSources.map((s) => s.label).join(", ")}`);
    }
    console.log("\n✅ Dry run complete — nothing was saved, no Anthropic calls were made.\n");
    return { dryRun: true, kept, skippedSources };
  }

  return runFullPipeline({ watchlist, env, edition, kept, items, skippedSources, fetchedCount });
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

  console.log(`\n✅ Saved ${deliveredTo.join(" · posted to ")}\n`);
}

/**
 * Answer a question over stored items + recent briefs with one Sonnet call.
 * Shared by the CLI (`query`) and the web UI search page.
 * @returns {{ answer: string, hits: object[] }}
 */
export async function answerQuery(question, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }

  const itemHits = store.searchSeenItems(question);
  // Also grab words individually if the full phrase found nothing.
  const extraHits =
    itemHits.length === 0
      ? question.split(/\s+/).filter((w) => w.length > 3).flatMap((w) => store.searchSeenItems(w, 10))
      : [];
  const allHits = [...new Map([...itemHits, ...extraHits].map((h) => [h.uid, h])).values()].slice(0, 30);

  // Most recent few briefs as context.
  const briefTexts = [];
  for (const b of store.listBriefs(4)) {
    const p = path.join(store.DATA_DIR, b.path);
    if (fs.existsSync(p)) briefTexts.push(`--- Brief ${b.path} ---\n${fs.readFileSync(p, "utf8").slice(0, 6000)}`);
  }

  if (allHits.length === 0 && briefTexts.length === 0) {
    return { answer: "Nothing stored yet matches. Run the pipeline a few times first.", hits: [] };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-4-6";
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system:
      "You answer questions for an Iowa Soybean Association policy professional using ONLY the stored monitoring data provided. Cite item titles and URLs (as markdown links) when available. If the stored data doesn't answer the question, say so plainly.",
    messages: [
      {
        role: "user",
        content: `Question: ${question}\n\nStored items (JSON):\n${JSON.stringify(allHits, null, 1)}\n\nRecent briefs:\n${briefTexts.join("\n\n") || "(none)"}`,
      },
    ],
  });
  store.recordUsage(model, "query", response.usage.input_tokens, response.usage.output_tokens);
  return { answer: response.content.find((b) => b.type === "text")?.text ?? "(no answer)", hits: allHits };
}

export async function runQuery(question, env) {
  console.log(`\n🔍 Searching stored briefs and items for: "${question}"…`);
  const { answer } = await answerQuery(question, env);
  console.log("\n" + answer + "\n");
}

/**
 * Weekly synthesis: one Sonnet call over the week's daily briefs → a trend memo
 * suitable for forwarding to colleagues. Saved as YYYY-MM-DD-weekly.md.
 */
export async function runWeekly(env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env — get one at console.anthropic.com");
  }
  const watchlist = loadWatchlist();
  const timezone = watchlist.briefEditions?.timezone ?? "America/Chicago";

  console.log("\n📚 Weekly synthesis: gathering this week's briefs…");
  const weekAgo = Date.now() - 7 * 86400e3;
  const weekBriefs = store
    .listBriefs(30)
    .filter((b) => Date.parse(b.created_at) >= weekAgo && !b.path.includes("weekly"))
    .reverse(); // oldest first reads chronologically

  if (weekBriefs.length === 0) {
    console.log("   No daily briefs from the past week — nothing to synthesize.\n");
    return;
  }

  const texts = weekBriefs
    .map((b) => {
      const p = path.join(store.DATA_DIR, b.path);
      return fs.existsSync(p) ? `--- ${path.basename(b.path)} ---\n${fs.readFileSync(p, "utf8").slice(0, 9000)}` : "";
    })
    .filter(Boolean);

  console.log(`   Synthesizing ${texts.length} briefs (${env.BRIEF_MODEL || "claude-sonnet-4-6"})…`);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.BRIEF_MODEL || "claude-sonnet-4-6";
  const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const response = await client.messages.create({
    model,
    max_tokens: 6000,
    system: `You write the Iowa Soybean Association's WEEKLY policy synthesis from the week's daily briefs. Audience: ISA colleagues and board members who did not read the dailies. Structure:

## ISA Weekly Policy Memo — week ending ${dateLabel}

### The week in three sentences
### 📈 Developing trends
What moved this week and what direction it's heading — connect related items across days.
### 🔴 What needs attention next week
Action items: comment deadlines approaching, votes scheduled, rules expected.
### 📋 Everything else worth knowing
One line each.

Rules: never invent items; every referenced item keeps its markdown link from the source brief; plain professional English, no jargon; omit empty sections.`,
    messages: [{ role: "user", content: `This week's daily briefs:\n\n${texts.join("\n\n")}` }],
  });
  store.recordUsage(model, "weekly", response.usage.input_tokens, response.usage.output_tokens);
  const markdown = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";

  const filePath = saveBrief(markdown, "weekly", timezone);
  let deliveredTo = [path.relative(store.DATA_DIR, filePath)];
  if (watchlist.output?.teams !== false) {
    try {
      if (await postToTeams(markdown, env)) deliveredTo.push("Teams");
    } catch (err) {
      console.log(`⚠️  Teams delivery failed: ${err.message}`);
    }
  }
  console.log(`\n✅ Saved ${deliveredTo.join(" · posted to ")}\n`);
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
