// Regression test for atomic watchlist writes: saveWatchlist must never leave the
// live watchlist.json truncated or torn — an interrupted/failed write has to keep
// the original intact (the whole app fails closed on an unreadable watchlist),
// and a normal save must leave no temp files behind.
//
// Run with: node --test test/config-write-safety.test.js

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pipeline.js resolves the watchlist path through store.js, which reads
// POLIBRIEF_DATA_DIR at import time — set it before any src module loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "polibrief-test-"));
process.env.POLIBRIEF_DATA_DIR = dataDir;
const watchlistPath = path.join(dataDir, "watchlist.json");
fs.writeFileSync(
  watchlistPath,
  JSON.stringify({ focusAreas: [{ id: "t", label: "T", terms: [] }], sources: {}, briefEditions: { am: "06:30" } }, null, 2)
);

const { loadWatchlist, saveWatchlist } = await import("../src/pipeline.js");

after(() => {
  fs.chmodSync(dataDir, 0o755); // in case the failure test left it read-only
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const tmpFiles = () => fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));

test("a normal save round-trips and leaves no temp files", () => {
  const w = loadWatchlist();
  w.briefEditions = { ...w.briefEditions, pm: "16:45" };
  saveWatchlist(w);

  const onDisk = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));
  assert.equal(onDisk.briefEditions.pm, "16:45");
  assert.equal(onDisk.briefEditions.am, "06:30");
  assert.equal("topics" in onDisk, false, "derived engine view is never persisted");
  assert.deepEqual(tmpFiles(), [], "no leftover .tmp files after a clean save");
});

test("a failed write throws, keeps the original intact, and leaves no temp files", () => {
  const before = fs.readFileSync(watchlistPath, "utf8");
  const w = loadWatchlist();
  w.briefEditions = { ...w.briefEditions, am: "07:00" };

  // A read-only directory makes the temp-file write fail (EACCES) — standing in for
  // any interrupted write. Pre-fix, the truncate-then-write happened on the live file.
  fs.chmodSync(dataDir, 0o555);
  try {
    assert.throws(() => saveWatchlist(w));
  } finally {
    fs.chmodSync(dataDir, 0o755);
  }

  assert.equal(fs.readFileSync(watchlistPath, "utf8"), before, "live file untouched by the failed save");
  assert.deepEqual(tmpFiles(), [], "failed save cleans up its temp file");
});
