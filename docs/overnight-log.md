# Overnight build log — 2026-07-06 night

Append-only. Each entry: item · result · files · test evidence · follow-up.
The loop reads `docs/overnight-queue.md` for the next `[ ]` item and its rules.

---

**23:1x — Session start (anchor + setup).** Deep trend retrieval done + committed `0200cfd`
(marketSnapshot now computes YoY / range+percentile / seasonal over full history; verified via a
real "is crush seasonally normal" query — model taught 100th-pctile-for-May, +4.6% YoY, 92nd
pctile of 113 obs). Memories saved (Pi hardware, education engine, source registry). Queue +
this log written. Loop armed. Next: Q1 (Drought Monitor).

<!-- loop appends below this line -->

**Wake 1 — Q1 U.S. Drought Monitor — ✅ DONE.** Keyless adapter `src/adapters/drought_monitor.js`
(USDM data services, percent-area endpoint; needed `aoi=19` FIPS + M/D/YYYY dates, rows newest-first,
d0..d4 cumulative). Two Iowa series: `drought_monitor:ia:d1` (% in drought, D1+) and `:ia:d0` (% dry+,
D0+), category `drought`. Wired: adapters/index.js (import+map+SOURCE_CLASS markets), watchlist.json
(enabled), server.js (drought chart). **Test:** fetchItems → "Iowa drought — 12% in drought (D1+), 33%
abnormally dry+ (week of 2026-06-30)"; fetchSeries → 2×601 weekly pts (2014-12-30→2026-06-30, d1=12.15
d0=33.34); market-refresh → 20 series; Markets page renders chart_drought (8 charts total), both series
in the blob, 0 server errors. Files committed: drought_monitor.js, adapters/index.js, watchlist.json,
server.js, + queue/log. Next: Q2 (NASS corn price + soy:corn ratio).

**Wake 2 — Q2 NASS corn price + soy:corn ratio — ✅ DONE.** Extended `usda_nass.js` fetchSeries:
added U.S. + Iowa **corn price received** (`nass:us:corn-price`, `nass:ia:corn-price`, category
`corn_price`) mirroring the soy price queries; added a **computed** `nass:ia:soy-corn-ratio`
(Iowa soy ÷ corn by shared month, category `soy_corn_ratio`, no extra API call). Two new charts
in server.js. **Test:** corn IA $4.45 / US $4.48 (2026-05, 113 pts each); ratio 2.56 (2026-05,
113 pts — above the ~2.5 beans/corn pivot); market-refresh → 23 series; Markets page = **10 chart
boxes**, corn_price + soy_corn_ratio present, 0 errors. Files: usda_nass.js, server.js, + queue/log.
**GOTCHA for future wakes:** the background verify server can linger and hold its port (MSYS `kill`
doesn't always reap node.exe) → a stale server serves OLD code and the check looks like a fail. FIX
used: kill by port via `netstat -ano | grep LISTENING | grep :PORT` → `taskkill //F //PID`, then
verify on a FRESH port (8488). NEVER blanket-kill node (would hit the other chat's 8485). Next: Q3
(curriculum + glossary store scaffold — no API).

**Wake 3 — Q3 curriculum + glossary store — ✅ DONE.** Education-engine scaffold, no API. Added
`concepts` + `glossary` SQLite tables in store.js with `upsertConcept` (preserves last_used on
re-seed), `listConcepts`, **`pickConcept(month)`** (season-aware least-recently-used rotation for
the daily teaching thread), `getGlossary`/`getTerm`/`upsertGlossaryTerm`. New `src/curriculum.js`
= 10 starter concepts (~130-word plain, "teach don't tell" bodies: basis, stocks-to-use, balance
sheet, WASDE, board-vs-cash, managed money, crush, condition ratings, Brazil, soy:corn ratio) +
15 glossary terms, each with a `season_window`. CLI `seed-curriculum`. **Test:** seeded 10+15;
`pickConcept(7)` (July) returned two DIFFERENT July-eligible concepts on successive calls (wasde-101
→ futures-vs-cash) confirming season-aware LRU. Files: store.js, curriculum.js, index.js, + queue/log.
**PUNCH-LIST:** run `node src/index.js seed-curriculum` on the Pi (and locally) — Q6's education
brief mode depends on it; polibrief.db is gitignored so the seed doesn't ship in the image. Next:
Q4 (ag-news RSS additions).

**Wake 4 — Q4 ag-news RSS additions — ✅ DONE.** Probed 8 candidate feeds with the adapter's UA.
**Kept 4** (200 + real items, non-dupe): **farmdoc daily** (illinois.edu/feed — Matt high-signal),
**Farm Policy News**, **No-Till Farmer**, **Feedstuffs**. **Dropped:** AgWeb (403), Successful
Farming/agriculture.com (403), DTN Progressive Farmer (404) — commercial bot-block/retired RSS, as
the roadmap predicted; Brownfield already in registry (dupe, skipped). Added 4 `news_source` feed
entities to `registry.json` (registry.json was git-clean → safe to edit + commit only my diff).
**Test:** JSON valid (14 feed entities); registry-sync → 44 entities/80 channels (+4); rss adapter
`parseFeed` live: Feedstuffs 50 items, Farm Policy News 10 items ("USDA releases June 2026 Acreage
Report") — one farmdoc call hit a transient undici connect-timeout but retried fine (https.get probe
had 200; the feed is good). Files: registry.json + queue/log. Punch-list updated (pull new
registry.json → Pi /data). Next: Q5 (Brazil IBGE SIDRA adapter).
