# Changelog

## 1.3.0 — v2 foundation (Entity Registry · entity collection · two-render brief)

Additive extension of the v1 pipeline — the existing collect → score → triage →
brief → deliver flow is unchanged, and every new source/render is gated so the
running app is never broken. See `docs/V2.md` for architecture and go-live steps.

### Added
- **Entity Registry** — `entity`/`channel` tables (`src/store.js`), `src/registry.js`,
  and a hand-seeded `registry.json` (IA federal delegation, statewide execs, state +
  county parties). Deterministic attribution by plus-tag / domain / handle / external id.
- **Geo resolution** — `src/geo.js` resolves an address or venue to county + legislative
  districts via the free U.S. Census Geocoder (memoized in `geo_cache`).
- **Entity-driven collection** — `collect.js` hands registry channels to adapters:
  - `rss` — entity press/news feeds (RSS 2.0 + Atom).
  - `email_intake` — reads a dedicated collector inbox over IMAP and attributes each
    message to an entity. Disabled until a Gmail App Password is set.
- **Registry seeders** — `registry-seed openstates|fec|socrata` and `registry-refresh`.
  OpenStates (state legislators) and FEC (federal candidates) are live; Socrata/IECDB
  is compliance-gated (Iowa Code § 68B.32A(7)).
- **Two-render brief** — an optional farmer-facing, strictly nonpartisan render
  (`output.farmerBrief`), sent to `FARMER_BRIEF_TO` or saved/web like any brief.
- **Registry web page** (`/registry`) with channel-health monitoring; new CLI commands
  `registry-sync` / `registry-seed` / `registry-refresh` / `registry-health`.
- **Collector tooling** — `docs/collector-gmail.md` runbook + `scripts/subscribe.mjs`
  (subscribe worksheet + double-opt-in confirmation-link clicker).

### Changed
- Scoring boosts registry-sourced items; triage records `entityId` / `type` / `geo`.
- `seen_items` gains `entity_id` / `item_type` / `geo` columns (auto-migrated).

### Dependencies
- Added `imapflow` and `mailparser` (email-intake; lazy-loaded so they never affect
  the rest of the app until email-intake runs).

## 1.2.0
Rebrand to "The Bean Brief"; ISA theme + logo; Focus Area watchlist engine; per-item
AI summaries; split Sources/Watchlist pages; email delivery.
