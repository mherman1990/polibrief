// collect.js — orchestrates all adapters for one run.
//
// For each enabled source: compute its incremental window (last successful run,
// capped at 7 days on first run), call the adapter within its item budget, and
// filter out items we've already seen. A failing source logs a warning and is
// recorded as skipped — the run always continues with whatever worked ("fail soft").

import { adapters } from "./adapters/index.js";
import * as store from "./store.js";
import { channelsForKinds } from "./registry.js";

/**
 * @param {object} opts
 * @param {object} opts.watchlist  parsed watchlist.json
 * @param {object} opts.env        process.env
 * @param {string|null} opts.onlySource  restrict to a single source id (testing)
 * @returns {{ items: Item[], skippedSources: {id, label, reason}[], fetchedCount: number,
 *             watermarks: {sourceId: string, ts: string}[] }}
 * collectAll is read-only. `watermarks` are the PENDING per-source last-success advances
 * (one per source that fetched successfully, ts = when its fetch began); the caller must
 * apply them only after this run's items are durably recorded — advancing earlier would
 * consume the fetch window of items that die with the run and lose them forever.
 */
export async function collectAll({ watchlist, env, onlySource = null }) {
  const items = [];
  const skippedSources = [];
  const watermarks = [];
  let fetchedCount = 0;

  for (const [sourceId, adapter] of Object.entries(adapters)) {
    const sourceConfig = watchlist.sources?.[sourceId];
    if (onlySource && sourceId !== onlySource) continue;
    if (!sourceConfig) {
      console.log(`⚠️  ${adapter.label}: no entry in watchlist.json "sources" — skipping`);
      continue;
    }
    if (!sourceConfig.enabled && !onlySource) continue;

    const runStartedAt = new Date().toISOString();
    const sinceISO = store.getSince(sourceId);
    try {
      // Entity-driven adapters (e.g. rss, ical, mobilize, email_intake) declare the
      // registry channel kinds they consume; topic-query adapters ignore `channels`.
      const channels = adapter.channelKinds ? channelsForKinds(adapter.channelKinds) : [];
      const fetched = await adapter.fetchItems({
        sinceISO,
        topics: watchlist.topics ?? [],
        sourceConfig,
        channels,
        env,
      });
      fetchedCount += fetched.length;
      const fresh = fetched.filter((item) => !store.isSeen(item.uid));
      console.log(
        `📥 ${adapter.label}: ${fetched.length} fetched since ${sinceISO.slice(0, 10)}, ${fresh.length} new`
      );
      items.push(...fresh);
      watermarks.push({ sourceId, ts: runStartedAt });
    } catch (err) {
      console.log(`⚠️  ${adapter.label}: skipped — ${err.message}`);
      skippedSources.push({ id: sourceId, label: adapter.label, reason: err.message });
    }
  }

  if (onlySource && !adapters[onlySource]) {
    const known = Object.keys(adapters).join(", ");
    throw new Error(`Unknown source "${onlySource}". Known sources: ${known}`);
  }

  return { items, skippedSources, fetchedCount, watermarks };
}
