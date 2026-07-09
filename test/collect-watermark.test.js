// Regression test for the collect-watermark data-loss bug: a run that fetches
// successfully but dies before its items are committed (missing ANTHROPIC_API_KEY,
// a triage API failure, a crash) must NOT advance the fetched sources' watermarks —
// otherwise the next run's "since last success" window skips items that were never
// recorded, and they are lost silently.
//
// Run with: npm test  (node --test test/)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// store.js resolves its SQLite path from POLIBRIEF_DATA_DIR at import time, so the
// env var must be set before any src module loads — hence the dynamic imports below.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "polibrief-test-"));
process.env.POLIBRIEF_DATA_DIR = dataDir;

const store = await import("../src/store.js");
const { collectAll } = await import("../src/collect.js");
const { runFullPipeline } = await import("../src/pipeline.js");
const { adapters } = await import("../src/adapters/index.js");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Two fake sources injected into the (mutable) adapter registry: one that fetches
// an item, one that always fails. Real adapters are skipped — the watchlist below
// only enables the fakes, and no network or Anthropic call is ever made.
const ITEM = {
  uid: "watermark-test:1",
  sourceId: "watermark_test",
  sourceLabel: "Watermark test source",
  title: "Test item",
  summary: "",
  url: "https://example.com/item",
  publishedAt: new Date().toISOString(),
  jurisdiction: "US-Federal",
  docType: "rule",
  raw: {},
};
adapters.watermark_test = {
  id: "watermark_test",
  label: "Watermark test source",
  fetchItems: async () => [ITEM],
};
adapters.watermark_broken = {
  id: "watermark_broken",
  label: "Broken test source",
  fetchItems: async () => {
    throw new Error("simulated fetch failure");
  },
};
const watchlist = {
  topics: [],
  sources: { watermark_test: { enabled: true }, watermark_broken: { enabled: true } },
};

const OLD = "2026-01-01T00:00:00.000Z";

test("collectAll is read-only: watermarks are returned pending, per source, not written", async () => {
  store.setLastSuccess("watermark_test", OLD);
  store.setLastSuccess("watermark_broken", OLD);

  const { items, skippedSources, watermarks } = await collectAll({ watchlist, env: {} });

  assert.ok(items.some((i) => i.uid === ITEM.uid), "fetched item is returned");
  assert.equal(store.getSince("watermark_test"), OLD, "collect must not advance the watermark");
  assert.equal(store.getSince("watermark_broken"), OLD);
  const ids = watermarks.map((w) => w.sourceId);
  assert.ok(ids.includes("watermark_test"), "successful fetch yields a pending advance");
  assert.ok(!ids.includes("watermark_broken"), "failed fetch yields no pending advance");
  assert.ok(skippedSources.some((s) => s.id === "watermark_broken"));
});

test("a run that dies before the commit point leaves watermarks untouched (the bug)", async () => {
  store.setLastSuccess("watermark_test", OLD);
  const { items, skippedSources, fetchedCount, watermarks } = await collectAll({ watchlist, env: {} });

  // env without ANTHROPIC_API_KEY: runFullPipeline throws before triage — the same
  // failure mode as a missing key or an Anthropic 429/5xx mid-run.
  await assert.rejects(
    () => runFullPipeline({ watchlist, env: {}, edition: "am", kept: items, items, skippedSources, fetchedCount, watermarks }),
    /ANTHROPIC_API_KEY/
  );

  assert.equal(store.getSince("watermark_test"), OLD, "failed run must not consume the fetch window");
  assert.equal(store.isSeen(ITEM.uid), false, "item stays unseen — refetchable next run");
});

test("watermarks advance to the fetch-start timestamp once items are committed", async () => {
  store.setLastSuccess("watermark_test", OLD);
  const { items, skippedSources, fetchedCount, watermarks } = await collectAll({ watchlist, env: {} });

  // kept=[] → triageItems returns before creating a client (no API call); the item is
  // recorded by the dropped-by-scoring loop, then the commit point applies watermarks.
  await runFullPipeline({
    watchlist,
    env: { ANTHROPIC_API_KEY: "test-key" },
    edition: "am",
    kept: [],
    items,
    skippedSources,
    fetchedCount,
    watermarks,
  });

  const advanced = store.getSince("watermark_test");
  assert.notEqual(advanced, OLD, "watermark advances after commit");
  assert.equal(advanced, watermarks.find((w) => w.sourceId === "watermark_test").ts, "advances to when its fetch began — no coverage gap");
  assert.equal(store.isSeen(ITEM.uid), true, "item is durably recorded");
});
