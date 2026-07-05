// server.js — the polibrief web UI + built-in scheduler.
//
// Pages:
//   GET  /                dashboard: run buttons, briefs, deadlines, sources, watchlist, settings
//   GET  /items           browse/filter stored items; track 📌 and rate 👍/👎
//   GET  /search?q=       ask a question over stored data (one Sonnet call per search)
//   GET  /logs            recent server output (last 500 lines)
//   GET  /brief/<file>    a rendered brief (+ copy/email/Teams buttons)
//   GET  /brief/<file>/raw  the brief's markdown (for the copy button)
//   GET  /calendar.ics    comment-deadline calendar — subscribe from Outlook
//   GET  /feed.xml        RSS feed of briefs
//   GET  /health          plain-text ok (Docker healthcheck; never behind auth)
//
// The scheduler runs the am/pm editions, the Friday weekly memo, and a nightly
// backup — no cron needed. Set POLIBRIEF_PASSWORD in .env to require a password
// (username can be anything).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import * as store from "./store.js";
import { runPipeline, runWeekly, answerQuery, loadWatchlist, saveWatchlist } from "./pipeline.js";
import { adapters } from "./adapters/index.js";
import { postToTeams } from "./deliver.js";
import { summarizeItem, summaryExpiry } from "./summarize.js";

// ---------- log ring buffer (powers /logs) ----------
const logBuffer = [];
function captureConsole() {
  for (const level of ["log", "error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logBuffer.push(`${new Date().toLocaleTimeString()} ${line}`);
      if (logBuffer.length > 500) logBuffer.shift();
    };
  }
}

// ---------- tiny markdown → HTML renderer (covers exactly what briefs contain) ----------
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(md) {
  return esc(md)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
export function markdownToHtml(md) {
  const out = [];
  let inList = false;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    const isListItem = /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t);
    if (inList && !isListItem) {
      out.push("</ul>");
      inList = false;
    }
    if (t === "") continue;
    if (t === "---") out.push("<hr>");
    else if (t.startsWith("### ")) out.push(`<h3>${inline(t.slice(4))}</h3>`);
    else if (t.startsWith("## ")) out.push(`<h2>${inline(t.slice(3))}</h2>`);
    else if (isListItem) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(t.replace(/^([-*]|\d+\.)\s+/, ""))}</li>`);
    } else out.push(`<p>${inline(t)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// ---------- page shell ----------
function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  /* ---- ISA brand palette (from ISA24 Branding Guidelines: primary p10, 40-tints) ---- */
  :root {
    --isa-dark: #004A8D; --isa-blue: #0070C3; --isa-gold: #FFC425; --isa-gold-light: #FFD370;
    --isa-dark-40: #9AB8D2; --isa-blue-40: #A5C6E3; --isa-gold-40: #FFE8AA; --isa-gold-light-40: #FFEEC7;
    --isa-rust: #C65E35; --isa-olive: #91A22B;
    --ink: #1c2b3a; --line: #d9e2ec; --surface: #ffffff;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 900px;
         margin: 0 auto; padding: 0 16px 64px; line-height: 1.55; color: var(--ink); background: var(--surface); }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
           border-bottom: 3px solid var(--isa-gold); padding: 14px 4px 10px; margin-bottom: 22px; }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .brand .logo { height: 40px; width: auto; display: block; border-radius: 3px; }
  .brand .brandname { font-weight: 700; font-size: 1.15rem; letter-spacing: .2px; color: var(--isa-dark); }
  nav { margin-left: auto; display: flex; gap: 2px; flex-wrap: wrap; font-weight: 600; }
  nav a { text-decoration: none; color: var(--isa-dark); padding: 6px 10px; border-radius: 6px 6px 0 0;
    border-bottom: 3px solid transparent; }
  nav a:hover { background: var(--isa-blue-40); }
  nav a.active { border-bottom-color: var(--isa-gold); color: var(--isa-blue); }
  h1, h2, h3 { color: var(--isa-dark); }
  h1 { font-size: 1.5rem; margin: .2em 0 .5em; } h2 { font-size: 1.3rem; } h3 { margin-top: 26px; }
  ul.briefs { list-style: none; padding: 0; } ul.briefs li { margin: 8px 0; }
  ul.briefs a { font-weight: 600; text-decoration: none; }
  a { color: var(--isa-blue); } a:hover { text-decoration: underline; }
  .muted { opacity: .7; font-size: .9em; }
  hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
  form { display: inline; } button { background: var(--isa-blue); color: white; border: none;
    border-radius: 6px; padding: 6px 14px; font-size: .95rem; cursor: pointer; font-weight: 600; }
  button:hover { background: var(--isa-dark); }
  button.ghost { background: transparent; color: var(--isa-dark); border: 1px solid var(--isa-dark-40); }
  button.ghost:hover { background: var(--isa-blue-40); }
  button.tiny { padding: 2px 8px; font-size: .85rem; }
  .banner { background: var(--isa-blue-40); border: 1px solid var(--isa-blue); border-radius: 8px;
    padding: 8px 14px; margin: 12px 0; }
  .banner.err { background: #f7d9d3; border-color: var(--isa-rust); }
  table.sources, table.items { border-collapse: collapse; width: 100%; margin: 8px 0 4px; }
  table.sources th, table.sources td, table.items th, table.items td
    { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.sources th, table.items th { font-size: .85em; opacity: .7; font-weight: 600; }
  details.topic { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; margin: 8px 0; }
  details.topic[open] { border-color: var(--isa-dark-40); }
  details.topic summary { cursor: pointer; font-weight: 600; color: var(--isa-dark); }
  details.summary { margin: 6px 0 2px; }
  details.summary > summary { cursor: pointer; font-size: .9em; font-weight: 600; color: var(--isa-blue); list-style: none; }
  details.summary > summary::-webkit-details-marker { display: none; }
  details.summary > summary::before { content: "▸ "; }
  details.summary[open] > summary::before { content: "▾ "; }
  .sumbody { margin: 8px 0 4px; padding: 10px 12px; background: var(--isa-blue-40); border-radius: 8px; font-size: .95em; line-height: 1.5; }
  .sumbody p { margin: .4em 0; } .sumbody ul { margin: .4em 0; padding-left: 1.2em; }
  .summeta { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); font-size: .82em; opacity: .7; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0 10px; }
  form.chip { display: inline-flex; align-items: center; gap: 4px; background: var(--isa-gold-40);
    border: 1px solid var(--isa-gold); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: .9em; }
  form.chip button { background: none; color: inherit; padding: 0 6px; font-size: 1em; opacity: .6; }
  form.chip button:hover { opacity: 1; background: none; }
  form.addterm { display: inline-flex; gap: 6px; }
  input[type=text], input[type=number], input[type=time], select { border: 1px solid var(--isa-dark-40); border-radius: 6px;
    padding: 4px 8px; font-size: .9em; background: #fff; color: var(--ink); }
  form.addterm input[type=text] { min-width: 180px; }
  .kicker { font-size: .85em; opacity: .75; margin: 10px 0 2px; font-weight: 600; color: var(--isa-dark); }
  .spark { vertical-align: middle; margin-left: 8px; opacity: .8; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; align-items: center; }
  .answer { border: 1px solid var(--isa-blue); border-radius: 10px; padding: 6px 18px; margin: 14px 0;
    background: var(--isa-blue-40); }
  pre.logs { background: #f3f6f9; border: 1px solid var(--line); border-radius: 8px; padding: 12px;
    font-size: .8rem; overflow-x: auto; white-space: pre-wrap; color: var(--ink); }
  .fb { opacity: .55; } .fb.on { opacity: 1; }
</style></head>
<body><header>
<a class="brand" href="/"><img class="logo" src="/assets/isa-logo-main.png" alt="Iowa Soybean Association"><span class="brandname">The Bean Brief</span></a>
<nav><a href="/">Home</a><a href="/items">Items</a><a href="/watchlist">Watchlist</a><a href="/search">Search</a><a href="/sources">Sources</a><a href="/logs">Logs</a></nav>
</header>
<script>(function(){var p=location.pathname;document.querySelectorAll('nav a').forEach(function(a){var h=a.getAttribute('href');if(h==='/'?p==='/':p===h||p.indexOf(h+'/')===0)a.classList.add('active');});})();</script>
${body}
</body></html>`;
}

const SAFE_BRIEF_NAME = /^\d{4}-\d{2}-\d{2}-(am|pm|weekly)\.md$/;

// ---------- run management ----------
let runInProgress = false;
let lastRunProblem = null; // { when, message }

async function triggerRun(edition) {
  if (runInProgress) return "A run is already in progress — give it a minute.";
  runInProgress = true;
  try {
    if (edition === "weekly") await runWeekly(process.env);
    else await runPipeline({ edition, env: process.env });
    lastRunProblem = null;
    return null;
  } catch (err) {
    console.error(`❌ ${edition} run failed: ${err.message}`);
    lastRunProblem = { when: new Date().toLocaleString(), message: `${edition.toUpperCase()} run failed: ${err.message}` };
    return lastRunProblem.message;
  } finally {
    runInProgress = false;
  }
}

// ---------- reusable widgets ----------
function chip(topicId, kind, term) {
  return `<form method="post" action="/watchlist/update" class="chip">
    <input type="hidden" name="action" value="remove">
    <input type="hidden" name="topicId" value="${esc(topicId)}">
    <input type="hidden" name="kind" value="${esc(kind)}">
    <input type="hidden" name="term" value="${esc(term)}">
    <span>${esc(term)}</span><button title="Remove '${esc(term)}'">×</button>
  </form>`;
}

function addForm(topicId, kind, placeholder) {
  return `<form method="post" action="/watchlist/update" class="addterm">
    <input type="hidden" name="action" value="add">
    <input type="hidden" name="topicId" value="${esc(topicId)}">
    <input type="hidden" name="kind" value="${esc(kind)}">
    <input type="text" name="term" placeholder="${esc(placeholder)}" required>
    <button>Add</button>
  </form>`;
}

/** Tiny inline SVG sparkline of daily counts. */
function sparkline(series) {
  const max = Math.max(1, ...series);
  const w = 84;
  const h = 20;
  const step = w / Math.max(1, series.length - 1);
  const points = series.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="#0070C3" stroke-width="1.5"/></svg>`;
}

// ---------- dashboard sections ----------
function sourcesSection(watchlist, openId) {
  const stats = store.getSourceStats(7);
  const rows = Object.values(adapters)
    .map((adapter) => {
      const cfg = watchlist?.sources?.[adapter.id];
      const s = stats[adapter.id] ?? { seen: 0, relevant: 0, lastSuccess: null };
      const enabled = !(cfg && cfg.enabled === false);
      let dot, status;
      if (!enabled) {
        dot = "⚪";
        status = "turned off";
      } else if (s.lastSuccess && Date.now() - new Date(s.lastSuccess).getTime() < 36 * 60 * 60 * 1000) {
        dot = "🟢";
        status = `checked ${new Date(s.lastSuccess).toLocaleString()}`;
      } else if (s.lastSuccess) {
        dot = "🟠";
        status = `last success ${new Date(s.lastSuccess).toLocaleString()} — check the logs`;
      } else {
        dot = "🟠";
        status = "waiting for first successful run";
      }
      const toggle = `<form method="post" action="/watchlist/source">
        <input type="hidden" name="sourceId" value="${esc(adapter.id)}">
        <input type="hidden" name="enabled" value="${enabled ? "false" : "true"}">
        <button class="ghost tiny">${enabled ? "turn off" : "turn on"}</button></form>`;
      return `<tr><td>${dot}</td><td><strong>${esc(adapter.label)}</strong><br><span class="muted">${esc(status)}</span></td>
        <td>${s.seen}</td><td>${s.relevant}</td><td>${toggle}</td></tr>`;
    })
    .join("\n");
  const states = watchlist?.sources?.legiscan?.states ?? [];
  return `
<h2>Sources</h2>
<table class="sources">
  <tr><th></th><th>Source</th><th>Items (7d)</th><th>Relevant (7d)</th><th></th></tr>
  ${rows}
</table>
<p class="muted">🟢 active · 🟠 needs attention · ⚪ turned off. Counts are new items recorded by full runs.</p>
<details class="topic" id="t-states"${openId === "states" ? " open" : ""}>
  <summary>LegiScan states searched <span class="muted">(${esc(states.join(", ") || "none")})</span></summary>
  <div class="kicker">Two-letter codes. Adding "US" also searches the U.S. Congress by full bill text.</div>
  <div class="chips">${states.map((s) => chip("states", "states", s)).join("")} ${addForm("states", "states", "add state code, e.g. US")}</div>
</details>`;
}

function deadlinesSection() {
  const deadlines = store.upcomingDeadlines(6);
  if (deadlines.length === 0) return "";
  const rows = deadlines
    .map(
      (d) =>
        `<li><strong>${esc(d.comment_deadline)}</strong> — <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(
          (d.title ?? "").slice(0, 90)
        )}</a></li>`
    )
    .join("\n");
  return `
<h2>⏰ Upcoming comment deadlines</h2>
<ul>${rows}</ul>
<p class="muted">📅 <a href="/calendar.ics">calendar.ics</a> — in Outlook: Calendar → Add calendar → Subscribe from web → paste this page's address ending in /calendar.ics. Deadlines then appear on your work calendar automatically.</p>`;
}

function watchlistSection(watchlist, openId, activity) {
  const topics = (watchlist?.topics ?? [])
    .map((topic) => {
      const keywordChips = (topic.keywords ?? []).map((k) => chip(topic.id, "keywords", k)).join("");
      // Query editors for every registered source (so new sources are addable
      // even before the topic has any terms for them).
      const querySections = Object.keys(adapters)
        .map((sourceId) => {
          const terms = topic.queries?.[sourceId] ?? [];
          const label = adapters[sourceId]?.label ?? sourceId;
          return `<div class="kicker">Search queries · ${esc(label)}</div>
            <div class="chips">${terms.map((t) => chip(topic.id, `query:${sourceId}`, t)).join("")}
            ${addForm(topic.id, `query:${sourceId}`, "add search phrase…")}</div>`;
        })
        .join("");
      const spark = activity?.[topic.id] ? sparkline(activity[topic.id]) : "";
      const weightForm = `<form method="post" action="/watchlist/topic" class="addterm">
        <input type="hidden" name="action" value="weight">
        <input type="hidden" name="topicId" value="${esc(topic.id)}">
        <label class="muted">weight <input type="number" name="weight" min="1" max="10" value="${esc(topic.weight)}" style="width:60px"></label>
        <button class="ghost tiny">save</button></form>`;
      const deleteForm = `<form method="post" action="/watchlist/topic" onsubmit="return confirm('Delete the topic \\'${esc(topic.label)}\\' and all its terms?')">
        <input type="hidden" name="action" value="delete">
        <input type="hidden" name="topicId" value="${esc(topic.id)}">
        <button class="ghost tiny">delete topic</button></form>`;
      return `<details class="topic" id="t-${esc(topic.id)}"${openId === topic.id ? " open" : ""}>
        <summary>${esc(topic.label)} <span class="muted">(weight ${esc(topic.weight)}, ${(topic.keywords ?? []).length} keywords)</span>${spark}</summary>
        <div class="toolbar">${weightForm} ${deleteForm}</div>
        <div class="kicker">Keywords (used for local scoring & matching)</div>
        <div class="chips">${keywordChips} ${addForm(topic.id, "keywords", "add keyword…")}</div>
        ${querySections}
      </details>`;
    })
    .join("\n");
  return `
<h2>Watchlist topics</h2>
<p class="muted">Click a topic to edit. Changes save to watchlist.json immediately and apply from the next run.</p>
${topics}
<details class="topic" id="t-newtopic"${openId === "newtopic" ? " open" : ""}>
  <summary>➕ Add a new topic</summary>
  <form method="post" action="/watchlist/topic" class="toolbar">
    <input type="hidden" name="action" value="add">
    <input type="text" name="label" placeholder="Topic name, e.g. Biotech / Gene Editing" required style="min-width:260px">
    <label class="muted">weight <input type="number" name="weight" min="1" max="10" value="7" style="width:60px"></label>
    <button>Create topic</button>
  </form>
  <p class="muted">Then open the new topic to add its keywords and search phrases.</p>
</details>`;
}

function settingsSection(watchlist, openId) {
  const ed = watchlist?.briefEditions ?? {};
  const out = watchlist?.output ?? {};
  const emailTo = process.env.BRIEF_EMAIL_TO;
  const emailConfigured = Boolean(process.env.SMTP_HOST && emailTo);
  const emailOn = out.email === true;
  return `
<details class="topic" id="t-settings"${openId === "settings" ? " open" : ""}>
  <summary>⚙️ Settings <span class="muted">(schedule, thresholds, Teams)</span></summary>
  <form method="post" action="/watchlist/settings">
    <div class="kicker">Schedule (${esc(ed.timezone ?? "America/Chicago")})</div>
    <div class="toolbar">
      <label class="muted">AM <input type="time" name="am" value="${esc(ed.am ?? "06:30")}"></label>
      <label class="muted">PM <input type="time" name="pm" value="${esc(ed.pm ?? "16:30")}"></label>
      <label class="muted">Weekly memo
        <select name="weeklyDay">
          ${["off", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            .map((d) => `<option value="${d}"${(ed.weekly ?? "Fri 17:00").startsWith(d) || (d === "off" && !ed.weekly) ? " selected" : ""}>${d}</option>`)
            .join("")}
        </select>
        <input type="time" name="weeklyTime" value="${esc((ed.weekly ?? "Fri 17:00").split(" ")[1] ?? "17:00")}">
      </label>
    </div>
    <div class="kicker">Pipeline thresholds</div>
    <div class="toolbar">
      <label class="muted">min local score <input type="number" name="minLocalScoreForTriage" value="${esc(out.minLocalScoreForTriage ?? 5)}" min="0" max="50" style="width:64px"></label>
      <label class="muted">max items to triage <input type="number" name="maxItemsToTriage" value="${esc(out.maxItemsToTriage ?? 80)}" min="5" max="300" style="width:70px"></label>
      <label class="muted">max items in brief <input type="number" name="maxItemsInBrief" value="${esc(out.maxItemsInBrief ?? 25)}" min="5" max="100" style="width:64px"></label>
    </div>
    <div class="toolbar"><button>Save settings</button></div>
  </form>
  <div class="kicker">Email delivery</div>
  <p class="muted">${
    emailConfigured
      ? `Briefs email to <strong>${esc(emailTo)}</strong> via ${esc(process.env.SMTP_HOST)}${
          emailOn ? "." : " — but email delivery is currently <strong>off</strong> in the watchlist (set output.email to true, then restart)."
        }`
      : "Not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS and BRIEF_EMAIL_TO in the .env file, enable email in the watchlist, then restart the app."
  }</p>
  <div class="kicker">Security</div>
  <p class="muted">${process.env.POLIBRIEF_PASSWORD ? "Password protection is ON." : "No password set. To require one, add POLIBRIEF_PASSWORD=yourpassword to .env and restart (fine to skip on a Tailscale-only network)."}</p>
</details>`;
}

function homeBody(notice, openId = null) {
  const briefs = store.listBriefs(60);
  const items = briefs
    .map((b) => {
      const name = path.basename(b.path);
      const label = name
        .replace(".md", "")
        .replace(/-(am|pm)$/, (m) => m.replace("-", " · ").toUpperCase())
        .replace(/-weekly$/, " · 📚 WEEKLY");
      return `<li><a href="/brief/${encodeURIComponent(name)}">${esc(label)}</a> <span class="muted">${esc(
        new Date(b.created_at).toLocaleString()
      )}</span></li>`;
    })
    .join("\n");

  let configSections;
  try {
    const watchlist = loadWatchlist();
    configSections = deadlinesSection() + settingsSection(watchlist, openId);
  } catch (err) {
    configSections = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }

  return `
${lastRunProblem ? `<div class="banner err">❌ ${esc(lastRunProblem.message)} <span class="muted">(${esc(lastRunProblem.when)})</span><br><span class="muted">Most common cause: missing API keys — edit the .env file in the app's data folder, then restart the app. Details on the <a href="/logs">Logs page</a>.</span></div>` : ""}
${notice ? `<div class="banner">${esc(notice)}</div>` : ""}
<p>
  <form method="post" action="/run"><input type="hidden" name="edition" value="am"><button>▶ Run AM brief now</button></form>
  <form method="post" action="/run"><input type="hidden" name="edition" value="pm"><button>▶ Run PM brief now</button></form>
  <form method="post" action="/run"><input type="hidden" name="edition" value="weekly"><button class="ghost">📚 Weekly memo now</button></form>
  ${runInProgress ? '<span class="muted"> a run is in progress…</span>' : ""}
</p>
<h2>Saved briefs <span class="muted" style="font-weight:400;font-size:.7em">(<a href="/feed.xml">RSS</a>)</span></h2>
${briefs.length ? `<ul class="briefs">${items}</ul>` : "<p class='muted'>No briefs yet. Click a Run button above, or wait for the next scheduled edition.</p>"}
${configSections}
`;
}

// ---------- sources page ----------
function sourcesBody(notice, openId) {
  let body;
  try {
    body = sourcesSection(loadWatchlist(), openId);
  } catch (err) {
    body = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }
  return `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${body}`;
}

// ---------- watchlist page ----------
function watchlistBody(notice, openId) {
  let body;
  try {
    const watchlist = loadWatchlist();
    const activity = store.activitySeries(watchlist.topics ?? [], 28);
    body = watchlistSection(watchlist, openId, activity);
  } catch (err) {
    body = `<div class="banner err">⚠️ ${esc(err.message)}</div>`;
  }
  return `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${body}`;
}

// ---------- items page ----------
function itemsBody(params, notice) {
  let watchlist = null;
  try {
    watchlist = loadWatchlist();
  } catch {
    /* filters degrade gracefully */
  }
  const filters = {
    q: params.get("q") ?? "",
    topicId: params.get("topic") ?? "",
    sourceId: params.get("source") ?? "",
    verdict: params.get("verdict") ?? "relevant",
    days: Number(params.get("days") ?? 30) || 30,
  };
  const rows = store.listItems({ ...filters, limit: 200 });
  const trackedKeys = new Set(store.listTracked().map((t) => t.uid));
  const back = `/items?${params.toString()}`;

  const topicOptions = (watchlist?.topics ?? [])
    .map((t) => `<option value="${esc(t.id)}"${filters.topicId === t.id ? " selected" : ""}>${esc(t.label)}</option>`)
    .join("");
  const sourceOptions = Object.values(adapters)
    .map((a) => `<option value="${esc(a.id)}"${filters.sourceId === a.id ? " selected" : ""}>${esc(a.label)}</option>`)
    .join("");

  const tracked = store.listTracked();
  const trackedBlock = tracked.length
    ? `<h2>📌 Tracked items</h2><ul>${tracked
        .map(
          (t) => `<li><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title ?? t.uid)}</a>
          <form method="post" action="/items/track" style="display:inline">
            <input type="hidden" name="uid" value="${esc(t.uid)}"><input type="hidden" name="on" value="false">
            <input type="hidden" name="back" value="${esc(back)}"><button class="ghost tiny">untrack</button></form></li>`
        )
        .join("")}</ul><p class="muted">New activity on tracked items gets a 📌 section at the top of every brief.</p>`
    : "";

  const summarizedSet = store.summarizedUids();
  const itemRows = rows
    .map((r) => {
      const isTracked = trackedKeys.has(r.uid);
      const hasSummary = summarizedSet.has(r.uid);
      const summaryPanel = `<details class="summary" data-uid="${esc(r.uid)}">
        <summary>🧠 AI summary${hasSummary ? ' <span class="muted">· ready</span>' : ""}</summary>
        <div class="sumbody"><span class="muted">Open to generate a ≤500-word summary of the linked document and why it matters.</span></div>
      </details>`;
      const trackBtn = `<form method="post" action="/items/track">
        <input type="hidden" name="uid" value="${esc(r.uid)}"><input type="hidden" name="on" value="${isTracked ? "false" : "true"}">
        <input type="hidden" name="back" value="${esc(back)}">
        <button class="ghost tiny" title="${isTracked ? "Stop tracking" : "Track: flag future movement in briefs"}">${isTracked ? "📌 tracked" : "📌 track"}</button></form>`;
      const fb = (val, emoji) => `<form method="post" action="/items/feedback">
        <input type="hidden" name="uid" value="${esc(r.uid)}"><input type="hidden" name="fb" value="${r.feedback === val ? "" : val}">
        <input type="hidden" name="back" value="${esc(back)}">
        <button class="ghost tiny fb${r.feedback === val ? " on" : ""}" title="${val === "up" ? "Good catch — more like this" : "Not relevant — fewer like this"}">${emoji}</button></form>`;
      return `<tr>
        <td><a href="${esc(r.url ?? "#")}" target="_blank" rel="noopener">${esc((r.title ?? r.uid).slice(0, 110))}</a>
          ${r.one_line ? `<br><span class="muted">${esc(r.one_line)}</span>` : ""}
          ${summaryPanel}</td>
        <td class="muted">${esc(r.jurisdiction ?? "")}<br>${esc((r.published_at ?? r.first_seen_at ?? "").slice(0, 10))}</td>
        <td class="muted">${esc(r.triage_verdict ?? "")}</td>
        <td><div class="toolbar" style="margin:0">${trackBtn}${fb("up", "👍")}${fb("down", "👎")}</div></td>
      </tr>`;
    })
    .join("\n");

  return `
${notice ? `<div class="banner">${esc(notice)}</div>` : ""}
${trackedBlock}
<h2>Stored items</h2>
<form method="get" action="/items" class="toolbar">
  <input type="text" name="q" placeholder="search title / summary…" value="${esc(filters.q)}">
  <select name="topic"><option value="">any topic</option>${topicOptions}</select>
  <select name="source"><option value="">any source</option>${sourceOptions}</select>
  <select name="verdict">
    <option value=""${filters.verdict === "" ? " selected" : ""}>any verdict</option>
    <option value="relevant"${filters.verdict === "relevant" ? " selected" : ""}>relevant</option>
    <option value="irrelevant"${filters.verdict === "irrelevant" ? " selected" : ""}>irrelevant</option>
  </select>
  <select name="days">${[7, 30, 90, 365].map((d) => `<option value="${d}"${filters.days === d ? " selected" : ""}>last ${d} days</option>`).join("")}</select>
  <button>Filter</button>
</form>
<p class="muted">👍/👎 teach the AI triage what you consider relevant — corrections are fed into future runs. 📌 tracks an item so new activity is flagged in briefs.</p>
<table class="items">
  <tr><th>Item</th><th>Where / when</th><th>Verdict</th><th>Actions</th></tr>
  ${itemRows || '<tr><td colspan="4" class="muted">Nothing matches these filters.</td></tr>'}
</table>
<script>
document.querySelectorAll('details.summary').forEach(function(d){
  d.addEventListener('toggle', function(){
    if(!d.open || d.dataset.loaded) return;
    d.dataset.loaded='1';
    var body=d.querySelector('.sumbody');
    body.innerHTML='<span class="muted">Generating summary… this can take ~10 seconds.</span>';
    fetch('/items/summary',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'uid='+encodeURIComponent(d.dataset.uid)})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j.ok){
          body.innerHTML=j.html+'<p class="summeta">'+(j.cached?'cached':'generated')+' · '+j.model+(j.expiresAt?(' · cached until '+j.expiresAt):'')+'</p>';
        } else {
          body.innerHTML='<span class="muted">⚠️ '+(j.error||'Could not summarize this item.')+'</span>';
          d.dataset.loaded='';
        }
      })
      .catch(function(e){ body.innerHTML='<span class="muted">⚠️ '+e+'</span>'; d.dataset.loaded=''; });
  });
});
</script>`;
}

// ---------- search page ----------
function searchBody(q, result, error) {
  return `
<h2>Ask your policy archive</h2>
<form method="get" action="/search" class="toolbar">
  <input type="text" name="q" placeholder='e.g. "what happened with 45Z guidance?"' value="${esc(q ?? "")}" style="min-width:320px" required>
  <button>Search</button>
</form>
<p class="muted">Answers come from everything polibrief has stored (items + briefs), with links. Each search makes one Sonnet call (~a cent).</p>
${error ? `<div class="banner err">⚠️ ${esc(error)}</div>` : ""}
${result ? `<div class="answer">${markdownToHtml(result.answer)}</div>` : ""}
`;
}

// ---------- feeds ----------
function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n");
}
function icsCalendar() {
  const events = store
    .upcomingDeadlines(200)
    .map((d) => {
      const date = d.comment_deadline.replace(/-/g, "");
      return [
        "BEGIN:VEVENT",
        `UID:${d.uid.replace(/[^A-Za-z0-9:_-]/g, "")}@polibrief`,
        `DTSTART;VALUE=DATE:${date}`,
        `SUMMARY:${icsEscape(`Comment deadline: ${(d.title ?? "").slice(0, 120)}`)}`,
        `DESCRIPTION:${icsEscape(`${d.one_line ?? ""}\n${d.url ?? ""}`)}`,
        `URL:${d.url ?? ""}`,
        "END:VEVENT",
      ].join("\r\n");
    })
    .join("\r\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//polibrief//EN", "X-WR-CALNAME:ISA Policy Deadlines", events, "END:VCALENDAR"].join("\r\n");
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function rssFeed(host) {
  const base = `http://${host}`;
  const entries = store
    .listBriefs(20)
    .map((b) => {
      const name = path.basename(b.path);
      const p = path.join(store.DATA_DIR, b.path);
      const excerpt = fs.existsSync(p) ? fs.readFileSync(p, "utf8").slice(0, 600) : "";
      return `<item>
  <title>${xmlEscape(name.replace(".md", ""))}</title>
  <link>${xmlEscape(`${base}/brief/${encodeURIComponent(name)}`)}</link>
  <guid>${xmlEscape(`${base}/brief/${encodeURIComponent(name)}`)}</guid>
  <pubDate>${new Date(b.created_at).toUTCString()}</pubDate>
  <description>${xmlEscape(excerpt)}</description>
</item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>polibrief — ISA policy briefs</title>
<link>${xmlEscape(base)}</link>
<description>Twice-daily policy briefs for Iowa soybean priorities</description>
${entries}
</channel></rss>`;
}

// ---------- helpers ----------
async function readForm(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "topic";
}

function checkAuth(req, res) {
  const password = process.env.POLIBRIEF_PASSWORD;
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (supplied === password) return true;
  }
  res.writeHead(401, { "www-authenticate": 'Basic realm="polibrief"', "content-type": "text/plain" });
  res.end("Password required (any username; password from POLIBRIEF_PASSWORD in .env)");
  return false;
}

/**
 * First-boot convenience inside Docker/Umbrel: seed the data volume with an
 * editable watchlist.json and .env so the user can change settings without
 * touching the container image.
 */
function seedDataDir() {
  if (store.DATA_DIR === store.PROJECT_ROOT) return;
  const seeds = [
    { from: path.join(store.PROJECT_ROOT, "watchlist.json"), to: path.join(store.DATA_DIR, "watchlist.json") },
    { from: path.join(store.PROJECT_ROOT, ".env.example"), to: path.join(store.DATA_DIR, ".env") },
  ];
  for (const { from, to } of seeds) {
    if (!fs.existsSync(to) && fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      console.log(`📄 Created editable ${path.basename(to)} at ${to} — edit it there.`);
    }
  }
}

// ---------- the server ----------
export async function startServer({ port = 8484, schedule = true } = {}) {
  captureConsole();
  seedDataDir();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }

      // static brand asset (public — loads on the login page too)
      if (req.method === "GET" && url.pathname === "/assets/isa-logo-main.png") {
        try {
          const buf = fs.readFileSync(new URL("./assets/isa-logo-main.png", import.meta.url));
          res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
          res.end(buf);
        } catch {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        }
        return;
      }

      if (!checkAuth(req, res)) return;

      // ----- pages -----
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief", homeBody(url.searchParams.get("notice"), url.searchParams.get("open"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/items") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · items", itemsBody(url.searchParams, url.searchParams.get("notice"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/search") {
        const q = url.searchParams.get("q");
        let result = null;
        let error = null;
        if (q) {
          try {
            result = await answerQuery(q, process.env);
          } catch (err) {
            error = err.message;
          }
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · search", searchBody(q, result, error)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/logs") {
        const body = `<h2>Recent activity</h2><pre class="logs">${esc(logBuffer.slice(-300).join("\n") || "(nothing yet)")}</pre>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · logs", body));
        return;
      }

      if (req.method === "GET" && url.pathname === "/watchlist") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · watchlist", watchlistBody(url.searchParams.get("notice"), url.searchParams.get("open"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/sources") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("The Bean Brief · sources", sourcesBody(url.searchParams.get("notice"), url.searchParams.get("open"))));
        return;
      }

      if (req.method === "GET" && url.pathname === "/calendar.ics") {
        res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
        res.end(icsCalendar());
        return;
      }

      if (req.method === "GET" && url.pathname === "/feed.xml") {
        res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
        res.end(rssFeed(req.headers.host ?? "localhost:8484"));
        return;
      }

      // ----- briefs -----
      const briefMatch = url.pathname.match(/^\/brief\/([^/]+)(\/raw|\/teams)?$/);
      if (briefMatch) {
        const name = path.basename(decodeURIComponent(briefMatch[1]));
        const mode = briefMatch[2] ?? "";
        if (!SAFE_BRIEF_NAME.test(name)) {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        }
        const filePath = path.join(store.DATA_DIR, "briefings", name);
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        }
        const markdown = fs.readFileSync(filePath, "utf8");

        if (req.method === "GET" && mode === "/raw") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          res.end(markdown);
          return;
        }
        if (req.method === "POST" && mode === "/teams") {
          let notice;
          try {
            notice = (await postToTeams(markdown, process.env))
              ? `Posted ${name} to Teams.`
              : "Teams isn't configured — add TEAMS_WEBHOOK_URL to .env and restart.";
          } catch (err) {
            notice = `⚠️ Teams post failed: ${err.message}`;
          }
          redirect(res, `/brief/${encodeURIComponent(name)}?notice=${encodeURIComponent(notice)}`);
          return;
        }
        if (req.method === "GET") {
          const notice = url.searchParams.get("notice");
          const buttons = `<div class="toolbar">
            <button class="ghost" onclick="fetch('/brief/${encodeURIComponent(name)}/raw').then(r=>r.text()).then(t=>navigator.clipboard.writeText(t)).then(()=>this.textContent='✓ copied')">📋 Copy markdown</button>
            <a href="mailto:?subject=${encodeURIComponent("ISA Policy Brief " + name.replace(".md", ""))}&body=${encodeURIComponent("Brief attached below (or read it at " + `http://${req.headers.host}/brief/${name}` + " on the office network):%0A%0A")}"><button class="ghost" type="button">✉️ Email</button></a>
            <form method="post" action="/brief/${encodeURIComponent(name)}/teams"><button class="ghost">💬 Post to Teams</button></form>
          </div>`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            page(
              name,
              `${notice ? `<div class="banner">${esc(notice)}</div>` : ""}${buttons}${markdownToHtml(markdown)}<hr><p><a href="/">← All briefs</a></p>`
            )
          );
          return;
        }
      }

      // ----- actions -----
      if (req.method === "POST" && url.pathname === "/run") {
        const form = await readForm(req);
        const edition = ["am", "pm", "weekly"].includes(form.get("edition")) ? form.get("edition") : "am";
        triggerRun(edition).then((problem) => {
          if (problem) console.log(`⚠️  ${problem}`);
        });
        redirect(res, `/?notice=${encodeURIComponent(`${edition.toUpperCase()} run started — refresh in a minute or two. Problems will appear in a red banner here.`)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/summary") {
        const form = await readForm(req);
        const uid = form.get("uid") ?? "";
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        try {
          const item = store.getItemByUid(uid);
          if (!item) {
            res.end(JSON.stringify({ ok: false, error: "Item not found." }));
            return;
          }
          let cached = store.getSummary(uid);
          const fromCache = Boolean(cached);
          if (!cached) {
            const { summary, model } = await summarizeItem(item, process.env);
            if (!summary) throw new Error("The model returned an empty summary.");
            const expiresAt = summaryExpiry(item);
            store.saveSummary(uid, summary, model, expiresAt);
            cached = { summary, model, expires_at: expiresAt };
          }
          res.end(
            JSON.stringify({
              ok: true,
              cached: fromCache,
              model: cached.model,
              expiresAt: cached.expires_at ? String(cached.expires_at).slice(0, 10) : null,
              html: markdownToHtml(cached.summary),
            })
          );
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/track") {
        const form = await readForm(req);
        const uid = form.get("uid") ?? "";
        const on = form.get("on") === "true";
        let notice;
        if (on) notice = store.trackItem(uid) ? "📌 Tracking — new activity will be flagged in briefs." : "Item not found.";
        else {
          store.untrackItem(uid);
          notice = "Stopped tracking.";
        }
        const back = form.get("back") || "/items";
        redirect(res, `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/items/feedback") {
        const form = await readForm(req);
        const fb = form.get("fb");
        store.setFeedback(form.get("uid") ?? "", fb === "up" || fb === "down" ? fb : null);
        const notice = fb ? (fb === "up" ? "👍 Noted — more like this." : "👎 Noted — the AI will be told to avoid similar items.") : "Feedback cleared.";
        const back = form.get("back") || "/items";
        redirect(res, `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/teams/test") {
        let notice;
        try {
          notice = (await postToTeams("## polibrief test card\n\nIf you can read this in your channel, Teams delivery works. 🌱", process.env))
            ? "Test card sent — check your Teams channel."
            : "Teams isn't configured — add TEAMS_WEBHOOK_URL to .env and restart the app.";
        } catch (err) {
          notice = `⚠️ Teams test failed: ${err.message}`;
        }
        redirect(res, `/?notice=${encodeURIComponent(notice)}&open=settings#t-settings`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/source") {
        const form = await readForm(req);
        const sourceId = form.get("sourceId") ?? "";
        const enabled = form.get("enabled") === "true";
        let notice;
        try {
          if (!adapters[sourceId]) throw new Error(`Unknown source "${sourceId}"`);
          const watchlist = loadWatchlist();
          watchlist.sources ??= {};
          watchlist.sources[sourceId] ??= { maxItemsPerRun: 20 };
          watchlist.sources[sourceId].enabled = enabled;
          saveWatchlist(watchlist);
          notice = `${adapters[sourceId].label} turned ${enabled ? "on" : "off"}. Applies from the next run.`;
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        redirect(res, `/sources?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/topic") {
        const form = await readForm(req);
        const action = form.get("action");
        let notice;
        let openId = "newtopic";
        try {
          const watchlist = loadWatchlist();
          watchlist.topics ??= [];
          if (action === "add") {
            const label = (form.get("label") ?? "").trim();
            if (!label) throw new Error("The topic name was empty");
            const id = slugify(label);
            if (watchlist.topics.some((t) => t.id === id)) throw new Error(`A topic like "${label}" already exists`);
            const weight = Math.min(10, Math.max(1, Number(form.get("weight") ?? 7) || 7));
            watchlist.topics.push({ id, label, weight, keywords: [], queries: {} });
            saveWatchlist(watchlist);
            notice = `Created topic "${label}" — now open it and add keywords and search phrases.`;
            openId = id;
          } else if (action === "delete") {
            const topicId = form.get("topicId") ?? "";
            const idx = watchlist.topics.findIndex((t) => t.id === topicId);
            if (idx < 0) throw new Error(`Unknown topic "${topicId}"`);
            const [removed] = watchlist.topics.splice(idx, 1);
            saveWatchlist(watchlist);
            notice = `Deleted topic "${removed.label}".`;
            openId = "";
          } else if (action === "weight") {
            const topicId = form.get("topicId") ?? "";
            const topic = watchlist.topics.find((t) => t.id === topicId);
            if (!topic) throw new Error(`Unknown topic "${topicId}"`);
            topic.weight = Math.min(10, Math.max(1, Number(form.get("weight")) || topic.weight));
            saveWatchlist(watchlist);
            notice = `"${topic.label}" weight set to ${topic.weight}.`;
            openId = topicId;
          } else throw new Error("Unknown action");
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        const anchor = /^[A-Za-z0-9_-]+$/.test(openId) ? `#t-${openId}` : "";
        redirect(res, `/watchlist?notice=${encodeURIComponent(notice)}&open=${encodeURIComponent(openId)}${anchor}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/settings") {
        const form = await readForm(req);
        let notice;
        try {
          const watchlist = loadWatchlist();
          watchlist.briefEditions ??= {};
          const hhmm = /^\d{2}:\d{2}$/;
          if (hhmm.test(form.get("am") ?? "")) watchlist.briefEditions.am = form.get("am");
          if (hhmm.test(form.get("pm") ?? "")) watchlist.briefEditions.pm = form.get("pm");
          const day = form.get("weeklyDay");
          if (day === "off") delete watchlist.briefEditions.weekly;
          else if (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(day) && hhmm.test(form.get("weeklyTime") ?? "")) {
            watchlist.briefEditions.weekly = `${day} ${form.get("weeklyTime")}`;
          }
          watchlist.output ??= {};
          for (const key of ["minLocalScoreForTriage", "maxItemsToTriage", "maxItemsInBrief"]) {
            const value = Number(form.get(key));
            if (Number.isFinite(value) && value >= 0) watchlist.output[key] = value;
          }
          saveWatchlist(watchlist);
          notice = "Settings saved. Schedule changes apply within a minute; thresholds from the next run.";
        } catch (err) {
          notice = `⚠️ ${err.message}`;
        }
        redirect(res, `/?notice=${encodeURIComponent(notice)}&open=settings#t-settings`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/watchlist/update") {
        const form = await readForm(req);
        const action = form.get("action");
        const topicId = form.get("topicId") ?? "";
        const kind = form.get("kind") ?? "";
        const term = (form.get("term") ?? "").trim();

        let notice;
        const openId = kind === "states" ? "states" : topicId;
        try {
          const watchlist = loadWatchlist();
          if (!term) throw new Error("The term was empty");

          let list;
          let where;
          let value = term;
          if (kind === "states") {
            value = term.toUpperCase();
            if (!/^[A-Z]{2}$/.test(value)) throw new Error(`"${term}" isn't a two-letter code like IA or US`);
            watchlist.sources ??= {};
            watchlist.sources.legiscan ??= { enabled: true, maxItemsPerRun: 40 };
            watchlist.sources.legiscan.states ??= [];
            list = watchlist.sources.legiscan.states;
            where = "LegiScan state list";
          } else {
            const topic = (watchlist.topics ?? []).find((t) => t.id === topicId);
            if (!topic) throw new Error(`Unknown topic "${topicId}"`);
            if (kind === "keywords") {
              topic.keywords ??= [];
              list = topic.keywords;
              where = `keywords of "${topic.label}"`;
            } else if (kind.startsWith("query:")) {
              const sourceId = kind.slice("query:".length);
              if (!adapters[sourceId]) throw new Error(`Unknown source "${sourceId}"`);
              topic.queries ??= {};
              topic.queries[sourceId] ??= [];
              list = topic.queries[sourceId];
              where = `${adapters[sourceId].label} queries of "${topic.label}"`;
            } else {
              throw new Error("Unknown term type");
            }
          }

          const existingIdx = list.findIndex((t) => t.toLowerCase() === value.toLowerCase());
          if (action === "add") {
            if (existingIdx >= 0) notice = `"${value}" is already in the ${where}.`;
            else {
              list.push(value);
              saveWatchlist(watchlist);
              notice = `Added "${value}" to the ${where}. Applies from the next run.`;
            }
          } else if (action === "remove") {
            if (existingIdx < 0) notice = `"${value}" wasn't found in the ${where}.`;
            else {
              list.splice(existingIdx, 1);
              saveWatchlist(watchlist);
              notice = `Removed "${value}" from the ${where}. Applies from the next run.`;
            }
          } else {
            throw new Error("Unknown action");
          }
        } catch (err) {
          notice = `⚠️ Couldn't update the watchlist: ${err.message}`;
        }
        const anchor = /^[A-Za-z0-9_-]+$/.test(openId ?? "") ? `#t-${openId}` : "";
        const base = kind === "states" ? "/sources" : "/watchlist";
        redirect(res, `${base}?notice=${encodeURIComponent(notice)}&open=${encodeURIComponent(openId ?? "")}${anchor}`);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (err) {
      console.error(`⚠️  web error: ${err.message}`);
      res.writeHead(500, { "content-type": "text/plain" }).end("server error");
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`\n🌐 polibrief web UI on http://localhost:${port} (reachable on your LAN / Tailscale too)`);
  });

  if (schedule) {
    startScheduler();
  } else {
    console.log("⏸  Scheduler disabled (--no-schedule) — briefs only run when you click Run.");
  }

  return server;
}

// ---------- scheduler ----------
function startScheduler() {
  // Seed "already ran" from the briefs table so a container restart mid-day
  // doesn't re-run an edition.
  const ran = new Set();
  for (const b of store.listBriefs(10)) {
    const m = path.basename(b.path).match(/^(\d{4}-\d{2}-\d{2})-(am|pm|weekly)\.md$/);
    if (m) ran.add(`${m[1]}-${m[2]}`);
  }

  const check = async () => {
    let watchlist;
    try {
      watchlist = loadWatchlist();
    } catch {
      return; // bad watchlist edits shouldn't crash the server; run/CLI will report it
    }
    const editions = watchlist.briefEditions ?? {};
    const timezone = editions.timezone ?? "America/Chicago";
    const now = new Date();
    const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
    const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now); // "Fri"

    for (const edition of ["am", "pm"]) {
      const key = `${dateLabel}-${edition}`;
      if (editions[edition] && hhmm >= editions[edition] && !ran.has(key)) {
        ran.add(key);
        console.log(`\n⏰ Scheduled ${edition.toUpperCase()} edition (${editions[edition]} ${timezone})`);
        const problem = await triggerRun(edition);
        if (problem) console.log(`⚠️  ${problem}`);
      }
    }

    // Weekly memo, e.g. "Fri 17:00".
    const weekly = editions.weekly;
    if (weekly) {
      const [day, time] = weekly.split(/\s+/);
      const key = `${dateLabel}-weekly`;
      if (day === weekday && time && hhmm >= time && !ran.has(key)) {
        ran.add(key);
        console.log(`\n⏰ Scheduled weekly memo (${weekly} ${timezone})`);
        const problem = await triggerRun("weekly");
        if (problem) console.log(`⚠️  ${problem}`);
      }
    }

    // Nightly backup at 03:15 local.
    const backupKey = `${dateLabel}-backup`;
    if (hhmm >= "03:15" && !ran.has(backupKey)) {
      ran.add(backupKey);
      try {
        const dir = await store.backupNow();
        console.log(`💾 Nightly backup saved to ${dir} (newest 14 kept)`);
      } catch (err) {
        console.log(`⚠️  Backup failed: ${err.message}`);
      }
    }
  };

  setInterval(check, 30_000);
  console.log("⏰ Scheduler active — am/pm briefs, weekly memo, and a nightly 03:15 backup (times from watchlist.json).");
}
