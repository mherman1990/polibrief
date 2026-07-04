# polibrief — Product Summary & Expansion Context

> Purpose of this document: a complete snapshot of what polibrief is, how it's built,
> and where it could go — written so it can be pasted into a future AI session as
> context for planning expansions. Last updated: 2026-07-04 (v1.0.1).

## Who it's for

Matt, a policy professional at the **Iowa Soybean Association (ISA)** — a non-developer.
He tracks federal, state, and international policy affecting Iowa soybean farmers:
biofuels (RFS/RVO, 45Z, biodiesel/SAF), farm bill, conservation policy, trade/China/EUDR,
Iowa water quality, crop protection/FIFRA & eminent domain, right to repair, and dietary policy (MAHA/seed oils).
Works in a Microsoft shop (Teams, Outlook). Uses POLITICO, Agri-pulse. Runs a personal
Raspberry Pi 5 with umbrelOS (also runs Tailscale). His Windows work
PC and the Pi share a Tailscale network.

## What it does (one paragraph)

Twice a day (6:30 AM / 4:30 PM Central), polibrief polls five government data sources,
filters everything against a user-editable topic watchlist, scores items locally for free,
sends survivors to Claude Haiku for relevance triage, has Claude Sonnet write a structured
policy brief from the relevant items, and saves it as markdown — readable in a built-in
web app, optionally posted to a Microsoft Teams channel via incoming webhook.

## Data sources (adapters)

| Adapter | Coverage | Auth | Notes |
|---|---|---|---|
| `federal_register` | Federal rules/proposed rules/notices, scoped to EPA, USDA, Treasury/IRS, CFTC, USTR | none | Per-topic query terms + date window; captures comment deadlines |
| `congress_gov` | Federal bills updated recently (119th Congress) | free key | **Low recall by design**: API only exposes title + latest action, so verbatim matches are rare. Kept as a free backstop. |
| `legiscan` | State bills, full-text search: IA, IL, MN, NE, IN, MO, WI | free key (30k queries/mo) | `change_hash` folded into item identity so bills RE-surface when their status changes. Adding state code `US` (via web UI) enables full-text U.S. Congress search — the effective fix for congress_gov's thin matching. Currently OFF per user preference. |
| `eurlex_oj` | EU Official Journal L-series (regulations) | none | Parses public daily-view HTML pages (EUR-Lex RSS now requires account-bound IDs). Upgrade path: SOAP webservice / CELLAR SPARQL. |
| `iowa_admin_rules` | Iowa Administrative Bulletin rule filings | none | Parses the `#iacList` table on legis.iowa.gov; isolated selectors; fail-soft. Proof-of-concept for per-state admin-rules adapters. |

Adding a source = one file in `src/adapters/` implementing `{id, label, fetchItems({sinceISO, topics, sourceConfig, env})}` returning normalized Items (`uid, sourceId, sourceLabel, title, summary, url, publishedAt, jurisdiction, docType, raw`), registered in `src/adapters/index.js`, plus a `sources` entry in `watchlist.json`.

## Pipeline & cost discipline (core design)

1. **Collect** (`collect.js`) — each enabled source fetches only items since its last
   successful run (7-day cap on first run); already-seen items (SQLite) are dropped;
   failing sources warn + skip, never crash the run ("fail soft"); per-source
   `maxItemsPerRun` budgets.
2. **Score** (`score.js`) — free local keyword matching (word-boundary regex) against
   topic keywords; +3 boost for Iowa/soybean mentions; credit for the topic whose
   query found the item; threshold + cap from `watchlist.json` `output`.
3. **Triage** (`triage.js`) — `TRIAGE_MODEL` (claude-haiku-4-5) in batches of 15
   returns strict-JSON verdicts {relevant, topicIds, oneLine}; parsed defensively;
   every verdict stored so items are never paid for twice.
4. **Brief** (`brief.js`) — one `BRIEF_MODEL` (claude-sonnet-4-6) call writes the brief
   (exact template: 🔴 Top developments, per-source sections, ⏰ Deadlines); stats
   footer appended programmatically for accuracy; zero-relevant days skip Sonnet ($0).
5. **Deliver** (`deliver.js`) — saves `briefings/YYYY-MM-DD-{am|pm}.md` + SQLite index;
   Teams Adaptive Card if `TEAMS_WEBHOOK_URL` set (not yet configured by user);
   optional SMTP email (off).

Measured cost: ~$0.11 per busy run, $0 on quiet runs; ~$3–8/month expected.
Token usage logged per-model in SQLite; `audit` estimates monthly spend.

## Web app (`server.js`, port 8484) — v1.0.1 features

- Brief list + rendered brief pages (tiny built-in markdown renderer, no deps)
- ▶ Run AM/PM now buttons (background run, in-process lock)
- **Sources dashboard**: per-source status light (🟢/🟠/⚪), last-successful check,
  items found + relevant counts over trailing 7 days
- **Watchlist editor**: every topic expandable; keywords and per-source query phrases
  shown as pills with × remove + add box; **LegiScan states** editable the same way
  (2-letter validation; "US" = Congress full-text). Edits write `watchlist.json`
  immediately, apply next run, and the page returns with the edited section still
  open and scrolled into view.
- Built-in scheduler (checks `briefEditions` times in watchlist timezone every 30s;
  edition runs once/day; catch-up on restart) — no cron needed
- `/health` endpoint for Docker healthchecks
- Not yet in UI: topic add/delete, weights, source budgets/agencies, briefEditions times
  (all file-edits); no authentication (fine on LAN/Tailscale)

## CLI

`run --edition am|pm`, `run --dry-run` (no AI calls), `run --source X`,
`query "<question>"` (Sonnet over stored items+briefs), `audit`, `serve`.

## Tech stack & constraints

- Node 20+ ESM, better-sqlite3 (WAL), commander, dotenv, cheerio, fast-xml-parser,
  nodemailer, @anthropic-ai/sdk. No framework for the web UI (plain node:http + inline CSS).
- Models configurable in `.env` (TRIAGE_MODEL / BRIEF_MODEL).
- Mutable data (`polibrief.db`, `briefings/`, editable `watchlist.json`, `.env`) lives in
  `POLIBRIEF_DATA_DIR` (Docker volume `/data`); seeded on first boot.
- **Deployment**: Umbrel community app (clickable dashboard tile). Image built ON the Pi
  (arm64), pushed to `ghcr.io/mherman1990/polibrief:<version>`; store repo
  `github.com/mherman1990/isa-umbrel-apps` (folder `isa-polibrief/`: umbrel-app.yml,
  docker-compose.yml, icon.png = official ISA soybean mark). Update flow: scp changed
  src → Pi → docker build/tag/push new version → bump manifest version + compose tag on
  GitHub → re-add store → Update button (settings survive updates; uninstall wipes app data).
- Network quirk: the user's LAN intermittently can't reach Cloudflare-hosted services
  (Docker Hub, npm registry); GitHub/ghcr is reliable. Pi-hole runs on the same Umbrel.
- LegiScan quota 30k/month; ~100 queries/run at current config.
- The user prefers: max 2–3 debugging attempts on external APIs locally, then defer
  testing to the Pi; plain-English explanations; copy-paste commands with PC-vs-Pi
  prompts clearly labeled.

## File map

```
src/index.js      CLI          src/adapters/federal_register.js
src/pipeline.js   orchestrator src/adapters/congress_gov.js
src/collect.js    fetch loop   src/adapters/legiscan.js
src/store.js      SQLite       src/adapters/eurlex_oj.js
src/score.js      local filter src/adapters/iowa_admin_rules.js
src/triage.js     Haiku pass   src/adapters/index.js (registry)
src/brief.js      Sonnet brief scripts/install-pi.sh, crontab.example
src/deliver.js    save/Teams   docker/Dockerfile, docker-compose.yml
src/server.js     web UI + scheduler   umbrel-community-app-store/…
watchlist.json    single source of truth for topics/sources/schedule/thresholds
```

## Known gaps / friction (honest list)

- Teams webhook never configured/tested against a real channel
- Congress full-text coverage off (user chose to disable `US` LegiScan state)
- No feedback loop: can't mark a briefed item "not relevant" to tune future triage
- `query` is CLI-only; no search box in the web UI
- Brief archive isn't searchable/filterable in the UI
- No bill *tracking* (following a specific bill's lifecycle over time)
- Deadlines appear in briefs but don't reach a calendar
- App updates require a manual build-on-Pi + push + manifest bump cycle
- No auth on the web UI (acceptable on Tailscale/LAN only)
- No automated backup of the SQLite DB / data dir

## Expansion candidates (for future prioritization)

**Policy-work value**
1. **Comment-deadline calendar**: export ⏰ deadlines as an .ics feed Outlook can
   subscribe to; optional "3 days left to comment" reminder in briefs/Teams.
2. **Bill/docket tracking**: a "Tracked items" page — pin any briefed item; LegiScan
   change_hash already detects status changes; show a per-bill timeline and flag
   tracked-item movement at the top of briefs.
3. **Regulations.gov adapter**: comment dockets, docket status, public comment counts
   (free api.data.gov key — same key infrastructure as congress.gov).
4. **OIRA/reginfo.gov adapter**: rules under OMB review surface *before* they hit the
   Federal Register — genuine early warning.
5. **Litigation watch**: CourtListener/RECAP free API for pesticide/preemption and
   WOTUS cases (Bayer/glyphosate docket movement).
6. **Iowa Utilities Commission adapter**: CO2 pipeline dockets — directly on the
   eminent-domain topic.
7. **Weekly synthesis edition**: Friday Sonnet memo of trends across the week's briefs,
   suitable for forwarding to colleagues/board.
8. **Relevance feedback loop**: 👍/👎 on briefed items; feed recent verdict corrections
   into the triage prompt as few-shot examples.

**UI upgrades**
9. Search box in the web UI wired to the existing `query` pipeline (+ cited answers).
10. Brief archive filters (by topic, source, date) + full-text search of stored items.
11. Topic add/delete + weight sliders + source budgets in the UI (finish what the
    term editor started; remove the last reasons to hand-edit JSON).
12. Per-topic activity sparklines (items/week) on the dashboard; per-run log viewer.
13. "Send this brief" buttons: copy-to-clipboard, mailto:, Teams re-post.
14. RSS/Atom feed of briefs (many tools, incl. Teams/Outlook, can subscribe).

**Plumbing**
15. GitHub Actions to build/push the arm64 image on git push — updates become
    "click Update on Umbrel" with no Pi build step.
16. Nightly SQLite/data-dir backup (even a copy into briefings/ or a Tailscale-reachable share).
17. Optional basic-auth password for the web UI.
18. Configure + test Teams delivery end-to-end (webhook exists in .env but unset).
