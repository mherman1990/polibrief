// adapters/index.js — the adapter registry.
//
// Every data source implements the same interface:
//
//   export const id = "my_source";            // matches a key in watchlist.json "sources"
//   export const label = "My Source";         // human-friendly name for console output
//   export async function fetchItems({ sinceISO, topics, sourceConfig, env }) {
//     // returns Array<Item> — see README "Adding a Future Source" for the Item shape
//   }
//
// Adding a future source = add one file in this folder, then register it below.
// No other code changes needed; enable/disable and budgets live in watchlist.json.
//
// Deferred candidates (probed 2026-07-04, no machine-readable surface found):
//   - OIRA/reginfo.gov (rules under OMB review): JSP pages only, no API/RSS.
//   - Iowa Utilities Commission EFS (CO2 pipeline dockets): JavaScript-rendered
//     app, no server-side HTML. Revisit if either publishes an API.

import * as federal_register from "./federal_register.js";
import * as congress_gov from "./congress_gov.js";
import * as legiscan from "./legiscan.js";
import * as eurlex_oj from "./eurlex_oj.js";
import * as iowa_admin_rules from "./iowa_admin_rules.js";
import * as regulations_gov from "./regulations_gov.js";
import * as courtlistener from "./courtlistener.js";
import * as rss from "./rss.js";
import * as email_intake from "./email_intake.js";

export const adapters = {
  [federal_register.id]: federal_register,
  [congress_gov.id]: congress_gov,
  [legiscan.id]: legiscan,
  [eurlex_oj.id]: eurlex_oj,
  [iowa_admin_rules.id]: iowa_admin_rules,
  [regulations_gov.id]: regulations_gov,
  [courtlistener.id]: courtlistener,
  // v2 entity-driven sources (registry channels / collector inbox, not topic queries):
  [rss.id]: rss,
  [email_intake.id]: email_intake,
};
