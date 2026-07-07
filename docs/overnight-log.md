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
