#!/usr/bin/env node
// index.js — polibrief command line.
//
//   node src/index.js run --edition am        full pipeline: fetch → score → triage → brief → deliver
//   node src/index.js run --dry-run           fetch + score only, prints a table, NO Anthropic calls
//   node src/index.js run --source legiscan   restrict to one source (testing)
//   node src/index.js dry-run --source X      shorthand for run --dry-run --source X
//   node src/index.js query "45Z guidance"    ask a question over stored briefs + items
//   node src/index.js audit                   per-source stats + Anthropic token usage this month
//   node src/index.js serve                   web UI for reading briefs + built-in am/pm scheduler

import { Command } from "commander";
import dotenv from "dotenv";
import path from "node:path";

import { PROJECT_ROOT, DATA_DIR } from "./store.js";

// Prefer the data-volume .env (Docker/Umbrel); fall back to the project root.
dotenv.config({ path: [path.join(DATA_DIR, ".env"), path.join(PROJECT_ROOT, ".env")], quiet: true });

const program = new Command();
program.name("polibrief").description("Policy intelligence briefings for Iowa soybean priorities");

program
  .command("run")
  .description("Run the pipeline")
  .option("--edition <edition>", "am or pm", "am")
  .option("--dry-run", "fetch + score only; print a table; no Anthropic calls")
  .option("--source <sourceId>", "restrict to a single source (testing)")
  .action(async (opts) => {
    const { runPipeline } = await import("./pipeline.js");
    await runPipeline({ edition: opts.edition, dryRun: Boolean(opts.dryRun), source: opts.source ?? null });
  });

program
  .command("dry-run")
  .description("Shorthand for: run --dry-run")
  .option("--source <sourceId>", "restrict to a single source (testing)")
  .action(async (opts) => {
    const { runPipeline } = await import("./pipeline.js");
    await runPipeline({ dryRun: true, source: opts.source ?? null });
  });

program
  .command("weekly")
  .description("Generate the weekly synthesis memo from this week's daily briefs")
  .action(async () => {
    const { runWeekly } = await import("./pipeline.js");
    await runWeekly(process.env);
  });

program
  .command("query <question>")
  .description("Ask a question over stored briefs and seen items")
  .action(async (question) => {
    const { runQuery } = await import("./pipeline.js");
    await runQuery(question, process.env);
  });

program
  .command("audit")
  .description("Per-source stats, last-success times, and Anthropic token usage this month")
  .action(async () => {
    const { runAudit } = await import("./pipeline.js");
    await runAudit();
  });

program
  .command("serve")
  .description("Start the web UI (brief reader) with the built-in am/pm scheduler")
  .option("--port <port>", "port to listen on", process.env.PORT ?? "8484")
  .option("--no-schedule", "serve the UI only; don't run the pipeline on the am/pm schedule")
  .action(async (opts) => {
    const { startServer } = await import("./server.js");
    await startServer({ port: Number(opts.port), schedule: opts.schedule });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n❌ ${err.message}`);
  if (process.env.POLIBRIEF_DEBUG) console.error(err.stack);
  else console.error("   (set POLIBRIEF_DEBUG=1 for the full technical details)");
  process.exit(1);
});
