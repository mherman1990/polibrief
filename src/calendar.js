// calendar.js — the USDA / market report release calendar.
//
// The grain market moves on scheduled reports, not on a fixed twice-a-day clock. This module
// knows the recurring release cadence so the app can show "what's coming up" and hand the
// Analyst / Pulse writers the context of an imminent, market-moving report. Dates are computed
// from each report's cadence and are approximate (±a day or two) — enough for awareness; the
// exact date comes from the USDA release calendar on the day.

// ---- schedule generators: (from, end) => Date[] within the window ----
function weekly(weekday, seasonMonths) {
  return (from, end) => {
    const out = [];
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
    d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7)); // first matching weekday >= from
    while (d <= end) {
      if (!seasonMonths || seasonMonths.includes(d.getUTCMonth() + 1)) out.push(new Date(d));
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return out;
  };
}
function monthlyDay(day) {
  return (from, end) => {
    const out = [];
    let y = from.getUTCFullYear(), mo = from.getUTCMonth();
    for (let i = 0; i < 4; i++) {
      const d = new Date(Date.UTC(y, mo, day, 12));
      if (d >= from && d <= end) out.push(d);
      if (++mo > 11) { mo = 0; y++; }
    }
    return out;
  };
}
function annual(dates) {
  return (from, end) => {
    const out = [];
    for (const yr of [from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
      for (const { m, d } of dates) {
        const dt = new Date(Date.UTC(yr, m - 1, d, 12));
        if (dt >= from && dt <= end) out.push(dt);
      }
    }
    return out;
  };
}

const REPORTS = [
  { name: "WASDE", agency: "USDA", note: "World supply & demand — the big monthly balance-sheet update and the largest scheduled market-mover.", occ: monthlyDay(11) },
  { name: "Crop Production", agency: "USDA NASS", note: "Monthly production & yield estimates (released with WASDE).", occ: monthlyDay(11) },
  { name: "Weekly Export Sales", agency: "USDA FAS", note: "Weekly U.S. export commitments — the demand read.", occ: weekly(4) },
  { name: "Crop Progress & Condition", agency: "USDA NASS", note: "Weekly planting pace, crop condition, harvest (Apr–Nov).", occ: weekly(1, [4, 5, 6, 7, 8, 9, 10, 11]) },
  { name: "CFTC Commitments of Traders", agency: "CFTC", note: "Weekly fund positioning, as of Tuesday.", occ: weekly(5) },
  { name: "Grain Stocks", agency: "USDA NASS", note: "Quarterly stocks — historically one of the most volatile surprise days.", occ: annual([{ m: 1, d: 12 }, { m: 3, d: 31 }, { m: 6, d: 30 }, { m: 9, d: 30 }]) },
  { name: "Prospective Plantings", agency: "USDA NASS", note: "Spring acreage intentions.", occ: annual([{ m: 3, d: 31 }]) },
  { name: "Acreage", agency: "USDA NASS", note: "June planted acreage — a key surprise day.", occ: annual([{ m: 6, d: 30 }]) },
];

/** Upcoming report releases within `days`, soonest first. */
export function upcomingReports(days = 21, from = new Date()) {
  const end = new Date(from.getTime() + days * 86400e3);
  const out = [];
  for (const r of REPORTS) {
    for (const d of r.occ(from, end)) {
      out.push({ date: d.toISOString().slice(0, 10), name: r.name, agency: r.agency, note: r.note });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Compact text of the next few releases, for injecting into memo/analyst prompts. */
export function upcomingReportsText(days = 14) {
  const list = upcomingReports(days);
  if (!list.length) return "";
  return list.slice(0, 8).map((r) => `- ${r.date}: ${r.name} (${r.agency}) — ${r.note}`).join("\n");
}
