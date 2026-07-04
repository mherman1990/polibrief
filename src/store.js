// store.js — SQLite persistence layer.
//
// Everything polibrief remembers lives here:
//   - which items it has already seen (so nothing is ever re-processed or re-summarized)
//   - when each source last succeeded (drives incremental "only fetch new stuff" windows)
//   - an index of saved briefs
//   - rough Anthropic token usage (powers the `audit` command's cost estimate)
//
// The database file (polibrief.db) sits in the project root, next to watchlist.json.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Where mutable data (database, briefings) lives. Defaults to the project root;
// Docker/Umbrel set POLIBRIEF_DATA_DIR to a mounted volume so data survives updates.
const DATA_DIR = process.env.POLIBRIEF_DATA_DIR
  ? path.resolve(process.env.POLIBRIEF_DATA_DIR)
  : PROJECT_ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "polibrief.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_items (
    uid            TEXT PRIMARY KEY,
    source_id      TEXT NOT NULL,
    first_seen_at  TEXT NOT NULL,
    triage_verdict TEXT,            -- 'relevant' | 'irrelevant' | 'unscored'
    triage_topics  TEXT,            -- JSON array of topic ids
    title          TEXT,
    url            TEXT,
    jurisdiction   TEXT,
    one_line       TEXT             -- Haiku's one-line "why it matters" (relevant items only)
  );

  CREATE TABLE IF NOT EXISTS runs (
    source_id       TEXT PRIMARY KEY,
    last_success_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS briefs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    edition    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    path       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    model         TEXT NOT NULL,
    purpose       TEXT NOT NULL,    -- 'triage' | 'brief' | 'query' | 'weekly'
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracked_items (
    uid          TEXT PRIMARY KEY,   -- the seen_items uid at time of pinning
    track_key    TEXT NOT NULL,      -- stable identity across updates (LegiScan bill_id, else uid)
    title        TEXT,
    url          TEXT,
    jurisdiction TEXT,
    tracked_at   TEXT NOT NULL
  );
`);

// Column migrations for databases created by earlier versions. Adding a column
// that already exists throws — that's how we know it's already migrated.
for (const columnDef of [
  "comment_deadline TEXT", // from raw.commentsCloseOn (Federal Register / regulations.gov)
  "doc_type TEXT",
  "published_at TEXT",
  "feedback TEXT", // 'up' | 'down' from the web UI — feeds triage few-shots
]) {
  try {
    db.exec(`ALTER TABLE seen_items ADD COLUMN ${columnDef}`);
  } catch {
    /* column already exists */
  }
}

const stmtIsSeen = db.prepare("SELECT 1 FROM seen_items WHERE uid = ?");
const stmtMarkSeen = db.prepare(`
  INSERT INTO seen_items (uid, source_id, first_seen_at, triage_verdict, triage_topics, title, url, jurisdiction, one_line,
                          comment_deadline, doc_type, published_at)
  VALUES (@uid, @sourceId, @firstSeenAt, @verdict, @topics, @title, @url, @jurisdiction, @oneLine,
          @commentDeadline, @docType, @publishedAt)
  ON CONFLICT(uid) DO UPDATE SET
    triage_verdict = excluded.triage_verdict,
    triage_topics  = excluded.triage_topics,
    one_line       = excluded.one_line
`);
const stmtGetSince = db.prepare("SELECT last_success_at FROM runs WHERE source_id = ?");
const stmtSetLastSuccess = db.prepare(`
  INSERT INTO runs (source_id, last_success_at) VALUES (?, ?)
  ON CONFLICT(source_id) DO UPDATE SET last_success_at = excluded.last_success_at
`);

export function isSeen(uid) {
  return stmtIsSeen.get(uid) !== undefined;
}

/**
 * Record an item so it is never processed again.
 * verdict: { relevant: boolean, topicIds: string[], oneLine: string } or null (seen but not triaged).
 */
export function markSeen(item, verdict = null) {
  stmtMarkSeen.run({
    uid: item.uid,
    sourceId: item.sourceId,
    firstSeenAt: new Date().toISOString(),
    verdict: verdict === null ? "unscored" : verdict.relevant ? "relevant" : "irrelevant",
    topics: JSON.stringify(verdict?.topicIds ?? []),
    title: item.title ?? null,
    url: item.url ?? null,
    jurisdiction: item.jurisdiction ?? null,
    oneLine: verdict?.oneLine ?? null,
    commentDeadline: item.raw?.commentsCloseOn ?? null,
    docType: item.docType ?? null,
    publishedAt: item.publishedAt ?? null,
  });
}

/**
 * The incremental window start for a source: its last successful run,
 * capped at `fallbackDays` ago on first run so we never fetch the whole archive.
 */
export function getSince(sourceId, fallbackDays = 7) {
  const fallback = new Date(Date.now() - fallbackDays * 24 * 60 * 60 * 1000);
  const row = stmtGetSince.get(sourceId);
  if (!row) return fallback.toISOString();
  const last = new Date(row.last_success_at);
  // Guard against a corrupted/future timestamp making the window empty forever.
  if (Number.isNaN(last.getTime()) || last > new Date()) return fallback.toISOString();
  return last.toISOString();
}

export function setLastSuccess(sourceId, iso = new Date().toISOString()) {
  stmtSetLastSuccess.run(sourceId, iso);
}

export function recordBrief(edition, filePath) {
  db.prepare("INSERT INTO briefs (edition, created_at, path) VALUES (?, ?, ?)").run(
    edition,
    new Date().toISOString(),
    filePath
  );
}

export function listBriefs(limit = 50) {
  // A re-run of the same edition overwrites the same file; show each file once.
  return db
    .prepare(
      `SELECT edition, MAX(created_at) AS created_at, path
         FROM briefs GROUP BY path ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);
}

export function recordUsage(model, purpose, inputTokens, outputTokens) {
  db.prepare(
    "INSERT INTO token_usage (ts, model, purpose, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)"
  ).run(new Date().toISOString(), model, purpose, inputTokens ?? 0, outputTokens ?? 0);
}

/** Per-source item counts + last-success times, and this month's token usage, for `audit`. */
export function getAuditData() {
  const sourceCounts = db
    .prepare(
      `SELECT source_id,
              COUNT(*) AS total,
              SUM(CASE WHEN triage_verdict = 'relevant' THEN 1 ELSE 0 END) AS relevant
         FROM seen_items GROUP BY source_id ORDER BY source_id`
    )
    .all();
  const lastRuns = db.prepare("SELECT source_id, last_success_at FROM runs ORDER BY source_id").all();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthUsage = db
    .prepare(
      `SELECT model,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              COUNT(*)           AS calls
         FROM token_usage WHERE ts >= ? GROUP BY model ORDER BY model`
    )
    .all(monthStart.toISOString());
  const briefCount = db.prepare("SELECT COUNT(*) AS n FROM briefs").get().n;
  return { sourceCounts, lastRuns, monthUsage, briefCount };
}

/** Per-source activity for the web UI dashboard: items seen in the last N days + last successful check. */
export function getSourceStats(days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = {};
  for (const row of db
    .prepare(
      `SELECT source_id,
              COUNT(*) AS seen,
              SUM(CASE WHEN triage_verdict = 'relevant' THEN 1 ELSE 0 END) AS relevant
         FROM seen_items WHERE first_seen_at >= ? GROUP BY source_id`
    )
    .all(cutoff)) {
    stats[row.source_id] = { seen: row.seen, relevant: row.relevant ?? 0, lastSuccess: null };
  }
  for (const row of db.prepare("SELECT source_id, last_success_at FROM runs").all()) {
    stats[row.source_id] = { seen: 0, relevant: 0, ...stats[row.source_id], lastSuccess: row.last_success_at };
  }
  return stats;
}

/** Case-insensitive search over triaged items, newest first — used by the `query` command. */
export function searchSeenItems(term, limit = 30) {
  const like = `%${term}%`;
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, triage_verdict, triage_topics, one_line, first_seen_at
         FROM seen_items
        WHERE (title LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE)
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(like, like, limit);
}

// ---------------------------------------------------------------------------
// Item browsing, feedback, and tracking (web UI)

/**
 * Filterable listing of stored items for the /items page.
 * filters: { q, topicId, sourceId, verdict, days, limit }
 */
export function listItems({ q = "", topicId = "", sourceId = "", verdict = "", days = 30, limit = 200 } = {}) {
  const clauses = ["first_seen_at >= ?"];
  const params = [new Date(Date.now() - days * 86400e3).toISOString()];
  if (q) {
    clauses.push("(title LIKE ? COLLATE NOCASE OR one_line LIKE ? COLLATE NOCASE)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (topicId) {
    clauses.push("triage_topics LIKE ?");
    params.push(`%"${topicId}"%`);
  }
  if (sourceId) {
    clauses.push("source_id = ?");
    params.push(sourceId);
  }
  if (verdict) {
    clauses.push("triage_verdict = ?");
    params.push(verdict);
  }
  return db
    .prepare(
      `SELECT uid, source_id, title, url, jurisdiction, doc_type, triage_verdict, triage_topics,
              one_line, comment_deadline, published_at, first_seen_at, feedback
         FROM seen_items WHERE ${clauses.join(" AND ")}
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(...params, Math.min(limit, 500));
}

export function setFeedback(uid, feedback) {
  // feedback: 'up' | 'down' | null (clear)
  db.prepare("UPDATE seen_items SET feedback = ? WHERE uid = ?").run(feedback, uid);
}

/** Recent human corrections for the triage prompt: items where the human disagreed with Haiku. */
export function getFeedbackExamples(limit = 8) {
  return db
    .prepare(
      `SELECT title, triage_verdict, feedback FROM seen_items
        WHERE feedback IS NOT NULL
          AND ((feedback = 'down' AND triage_verdict = 'relevant') OR (feedback = 'up' AND triage_verdict = 'irrelevant'))
        ORDER BY first_seen_at DESC LIMIT ?`
    )
    .all(limit);
}

export function trackItem(uid) {
  const item = db.prepare("SELECT uid, title, url, jurisdiction FROM seen_items WHERE uid = ?").get(uid);
  if (!item) return false;
  // LegiScan uids look like legiscan:<bill_id>:<hash8> — the bill_id is the stable
  // identity across status changes, so track that; everything else tracks by uid.
  const m = uid.match(/^legiscan:(\d+):/);
  const trackKey = m ? `legiscan-bill:${m[1]}` : uid;
  db.prepare(
    "INSERT OR REPLACE INTO tracked_items (uid, track_key, title, url, jurisdiction, tracked_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(uid, trackKey, item.title, item.url, item.jurisdiction, new Date().toISOString());
  return true;
}

export function untrackItem(uid) {
  db.prepare("DELETE FROM tracked_items WHERE uid = ?").run(uid);
}

export function listTracked() {
  return db.prepare("SELECT * FROM tracked_items ORDER BY tracked_at DESC").all();
}

/** The set of stable track keys, for flagging movement during a run. */
export function trackedKeySet() {
  return new Set(db.prepare("SELECT track_key FROM tracked_items").all().map((r) => r.track_key));
}

/** Upcoming comment deadlines (for the .ics calendar + UI), soonest first. */
export function upcomingDeadlines(limit = 100) {
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT uid, title, url, comment_deadline, one_line, source_id FROM seen_items
        WHERE comment_deadline IS NOT NULL AND comment_deadline >= ?
        ORDER BY comment_deadline ASC LIMIT ?`
    )
    .all(today, limit);
}

/** Per-day item counts for sparklines: {topicId → number[days]} plus a total series. */
export function activitySeries(topics, days = 28) {
  const start = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db
    .prepare("SELECT first_seen_at, triage_topics FROM seen_items WHERE first_seen_at >= ?")
    .all(start);
  const dayIndex = (iso) => Math.min(days - 1, Math.max(0, Math.floor((Date.parse(iso) - Date.parse(start)) / 86400e3)));
  const series = { __all__: new Array(days).fill(0) };
  for (const t of topics) series[t.id] = new Array(days).fill(0);
  for (const row of rows) {
    const d = dayIndex(row.first_seen_at);
    series.__all__[d]++;
    let ids = [];
    try {
      ids = JSON.parse(row.triage_topics ?? "[]");
    } catch {
      /* ignore */
    }
    for (const id of ids) if (series[id]) series[id][d]++;
  }
  return series;
}

/** Online, safe SQLite backup + copies of watchlist/.env into DATA_DIR/backups/<date>/. */
export async function backupNow() {
  const dateLabel = new Date().toISOString().slice(0, 10);
  const dir = path.join(DATA_DIR, "backups", dateLabel);
  fs.mkdirSync(dir, { recursive: true });
  await db.backup(path.join(dir, "polibrief.db"));
  for (const name of ["watchlist.json", ".env"]) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  // Keep the newest 14 backups.
  const backupsRoot = path.join(DATA_DIR, "backups");
  const all = fs
    .readdirSync(backupsRoot)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse();
  for (const old of all.slice(14)) {
    fs.rmSync(path.join(backupsRoot, old), { recursive: true, force: true });
  }
  return dir;
}

export { DB_PATH, PROJECT_ROOT, DATA_DIR };
