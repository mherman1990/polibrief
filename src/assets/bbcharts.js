/* bbcharts.js — renders The Bean Brief's Markets charts with uPlot.
 *
 * The Markets page emits, per chart, a container <div id="chart_x"> plus a
 * <script class="bbchart" type="application/json" data-target="chart_x"> holding
 * { unit, height, series:[{label, points:[{period,value}]}] }. This reads those
 * blobs and draws an interactive multi-line chart: hover shows the month + each
 * series value (that's the live legend), with real time axes and gridlines.
 *
 * Vendored/static (no build step). Loaded after uPlot on the Markets page.
 */
(function () {
  var PALETTE = ["#004A8D", "#FFC425", "#0070C3", "#C65E35", "#6aa84f", "#9AB8D2", "#c0392b", "#8e7cc3", "#A5C6E3", "#91A22B"];

  function parsePeriod(p) {
    // "YYYY-MM" or "YYYY-MM-DD" -> unix seconds (UTC, so months land on the 1st).
    var m = String(p).split("-");
    return Date.UTC(+m[0], (+m[1] || 1) - 1, +m[2] || 1) / 1000;
  }

  function fmt(v) {
    if (v == null) return "—";
    return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
  }

  // Our periods are UTC month/day-firsts; format the x-axis + hover in UTC so monthly
  // points read as "Jan 2024" (not a tz-shifted "2024-01-31 6:00pm").
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function isMonthStart(dt) { return dt.getUTCDate() === 1 && dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0; }
  function fmtHoverX(ts) {
    var dt = new Date(ts * 1000);
    return isMonthStart(dt)
      ? MON[dt.getUTCMonth()] + " " + dt.getUTCFullYear()
      : MON[dt.getUTCMonth()] + " " + dt.getUTCDate() + ", " + dt.getUTCFullYear();
  }
  function fmtAxisX(ts) {
    var dt = new Date(ts * 1000);
    if (isMonthStart(dt)) {
      return dt.getUTCMonth() === 0 ? String(dt.getUTCFullYear()) : MON[dt.getUTCMonth()] + " '" + String(dt.getUTCFullYear()).slice(2);
    }
    return MON[dt.getUTCMonth()] + " " + dt.getUTCDate();
  }

  function build(box, spec) {
    var series = spec.series || [];
    var seen = {};
    series.forEach(function (s) {
      (s.points || []).forEach(function (pt) { seen[pt.period] = 1; });
    });
    var periods = Object.keys(seen).sort();
    if (periods.length < 2) {
      box.innerHTML = '<p class="muted">Not enough history yet.</p>';
      return;
    }
    var data = [periods.map(parsePeriod)];
    var uSeries = [{ value: function (u, ts) { return ts == null ? "—" : fmtHoverX(ts); } }];
    series.forEach(function (s, i) {
      var map = {};
      (s.points || []).forEach(function (pt) { map[pt.period] = pt.value; });
      data.push(periods.map(function (p) { return p in map ? map[p] : null; }));
      uSeries.push({
        label: s.label,
        stroke: PALETTE[i % PALETTE.length],
        width: 2,
        spanGaps: true,
        points: { show: false },
        value: function (u, v) { return v == null ? "—" : fmt(v) + (spec.unit ? " " + spec.unit : ""); },
      });
    });

    box.innerHTML = ""; // drop the "Loading chart…" placeholder before uPlot mounts
    function width() { return Math.max(260, box.clientWidth || 680); }
    var yAxis = {
      label: spec.unit || "",
      grid: { stroke: "#eef2f6", width: 1 },
      ticks: { stroke: "#e0e0e0" },
      values: function (u, ticks) { return ticks.map(function (t) { return Math.abs(t) >= 1000 ? Math.round(t).toLocaleString() : t; }); },
    };
    var u = new uPlot({
      width: width(),
      height: spec.height || 300,
      scales: { x: { time: true } },
      axes: [
        { grid: { stroke: "#eef2f6", width: 1 }, ticks: { stroke: "#e0e0e0" }, values: function (u, splits) { return splits.map(fmtAxisX); } },
        yAxis,
      ],
      series: uSeries,
      legend: { live: true },
      cursor: { focus: { prox: 24 } },
    }, data, box);

    window.addEventListener("resize", function () { u.setSize({ width: width(), height: spec.height || 300 }); });
    return u;
  }

  function init() {
    if (typeof uPlot === "undefined") return;
    var blobs = document.querySelectorAll("script.bbchart");
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var box = document.getElementById(b.getAttribute("data-target"));
      if (!box) continue;
      var spec;
      try { spec = JSON.parse(b.textContent); } catch (e) { continue; }
      try { build(box, spec); } catch (e) { box.innerHTML = '<p class="muted">Chart failed to render.</p>'; }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
