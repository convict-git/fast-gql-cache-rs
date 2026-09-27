/**
 * Renders the two benchmark charts the repository README embeds: speed and
 * memory of InMemoryCacheRs relative to Apollo's InMemoryCache, one point per
 * nightly run in `history.jsonl`. `history.mjs` writes them to `charts/` on the
 * `dnd-data/benchmarks` branch, a light and a dark file each, so the README
 * picks one with `<picture>` and updates without a commit to `main`.
 *
 * The charts are static SVG (GitHub serves README images without scripts), so
 * the legend carries each series' latest value as text. Values are
 * InMemoryCache ÷ InMemoryCacheRs, so higher is better and 1× is Apollo:
 * 2× is twice as fast, or half the memory. Unlike the trend page, which plots
 * the inverse, this reads as progress at a glance.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { geomean } from "./stats.mjs";

/**
 * The timing category of a performance-probe label. Labels name their
 * operation in words, so a label about broadcasts or watches is checked first
 * ("100 separate writes (100 broadcasts)" measures the broadcasts).
 */
export function speedCategory(label) {
  if (/broadcast|watch/i.test(label)) return "broadcast";
  if (/\b(write|writes|rewrite|overwrite)\b/i.test(label)) return "write";
  if (/\b(read|diff)\b/i.test(label)) return "read";
  return "other";
}

/**
 * The kind of a memory-probe label. Retained footprints are recorded per stage
 * as `<workload>: <stage>` (`retainedStages` in the memory probe, and the
 * steady workloads), allocations under a plain operation name (`allocated`).
 */
export const memoryKind = (label) =>
  label.includes(": ") ? "retained" : "allocated";

const SPEED = {
  file: "speed",
  title: "Speed: InMemoryCacheRs vs InMemoryCache",
  noun: "timings",
  unit: (m) => m.unit !== "B",
  series: [
    { name: "All timings", test: () => true },
    { name: "Writes", test: (l) => speedCategory(l) === "write" },
    { name: "Reads", test: (l) => speedCategory(l) === "read" },
    { name: "Broadcasts", test: (l) => speedCategory(l) === "broadcast" },
  ],
  above: "faster",
};

const MEMORY = {
  file: "memory",
  title: "Memory: InMemoryCacheRs vs InMemoryCache",
  noun: "memory measurements",
  unit: (m) => m.unit === "B",
  series: [
    { name: "All memory", test: () => true },
    { name: "Retained", test: (l) => memoryKind(l) === "retained" },
    { name: "Allocated", test: (l) => memoryKind(l) === "allocated" },
  ],
  above: "smaller",
};

/**
 * GitHub's own page colours, so the charts sit on the README like part of it;
 * the four categorical slots are validated for colour-vision deficiency on
 * both surfaces (adjacent pairs, the dataviz palette's first four slots).
 */
const THEMES = {
  light: {
    surface: "#ffffff",
    border: "#d1d9e0",
    ink: "#1f2328",
    muted: "#59636e",
    grid: "#e6e9ed",
    baseline: "#818b98",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  },
  dark: {
    surface: "#0d1117",
    border: "#3d444d",
    ink: "#f0f6fc",
    muted: "#9198a1",
    grid: "#21262d",
    baseline: "#656c76",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500"],
  },
};

/** One point per run: the series' geometric mean of InMemoryCache ÷ InMemoryCacheRs. */
export function seriesPoints(runs, chart) {
  return chart.series.map((s) => {
    const points = [];
    runs.forEach((run, i) => {
      const ratios = Object.entries(run.measurements ?? {})
        .filter(([label, m]) => chart.unit(m) && s.test(label))
        .filter(([, m]) => m.apollo > 0 && m.rs > 0)
        .map(([, m]) => m.apollo / m.rs);
      if (ratios.length)
        points.push({ i, value: geomean(ratios), count: ratios.length });
    });
    return { name: s.name, points };
  });
}

const W = 800;
const H = 380;
const PLOT = { left: 56, right: 150, top: 100, bottom: 330 };
const TICKS = [
  1 / 64,
  1 / 32,
  1 / 16,
  1 / 8,
  1 / 4,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
  24,
  32,
  48,
  64,
];

const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const fmtX = (v) =>
  v >= 10 ? `${v.toFixed(1)}×`
  : v >= 0.1 ? `${v.toFixed(2)}×`
  : `${v.toPrecision(2)}×`;
const tickLabel = (v) => `${v}×`;
const r1 = (n) => Math.round(n * 10) / 10;

/** The SVG of one chart in one theme. */
export function renderChart(runs, chart, themeName) {
  const theme = THEMES[themeName];
  const series = seriesPoints(runs, chart);
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const goal = 2;

  const text = (x, y, content, attrs = "") =>
    `<text x="${r1(x)}" y="${r1(y)}" ${attrs}>${esc(content)}</text>`;
  const out = [];
  const titleId = `${chart.file}-title`;
  const descId = `${chart.file}-desc`;
  const latestRun = runs.at(-1);
  const desc =
    all.length ?
      `${series
        .filter((s) => s.points.length)
        .map((s) => {
          const last = s.points.at(-1);
          return `${s.name}: ${fmtX(last.value)} (${last.count} measurements)`;
        })
        .join("; ")}, as of ${latestRun.date.slice(0, 10)}.`
    : "No runs recorded yet.";

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="${titleId} ${descId}" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`,
    `<title id="${titleId}">${esc(chart.title)}</title>`,
    `<desc id="${descId}">InMemoryCache ÷ InMemoryCacheRs, nightly on main; higher is ${chart.above}. ${esc(desc)}</desc>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${theme.surface}" stroke="${theme.border}"/>`,
    text(
      24,
      34,
      chart.title,
      `font-size="16" font-weight="600" fill="${theme.ink}"`
    ),
    text(
      24,
      56,
      `How many times ${chart.above} than InMemoryCache: geometric mean of the probe's ${chart.noun}, nightly on main.`,
      `font-size="12" fill="${theme.muted}"`
    )
  );

  // Legend: always present, and it carries the latest value of each series.
  const slot = (W - 48) / chart.series.length;
  series.forEach((s, k) => {
    const x = 24 + k * slot;
    const last = s.points.at(-1);
    out.push(
      `<line x1="${r1(x)}" y1="80" x2="${r1(x + 18)}" y2="80" stroke="${theme.series[k]}" stroke-width="3" stroke-linecap="round"/>`,
      `<text x="${r1(x + 26)}" y="84" font-size="12" fill="${theme.muted}">${esc(s.name)} <tspan font-weight="600" fill="${theme.ink}">${last ? fmtX(last.value) : "—"}</tspan></text>`
    );
  });

  if (!all.length) {
    out.push(
      text(
        W / 2,
        (PLOT.top + PLOT.bottom) / 2,
        "No runs recorded yet.",
        `font-size="14" text-anchor="middle" fill="${theme.muted}"`
      ),
      "</svg>"
    );
    return out.join("\n") + "\n";
  }

  // Log scale, so a ratio's distance from 1× reads the same both ways, and
  // symmetric around 1×: the goal above, as much room for a regression below.
  const lo = Math.min(...all, 1 / goal) / 1.12;
  const hi = Math.max(...all, goal) * 1.12;
  const y = (v) =>
    PLOT.bottom -
    ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) *
      (PLOT.bottom - PLOT.top);
  const first = Math.min(...series.flatMap((s) => s.points.map((p) => p.i)));
  const last = runs.length - 1;
  const x = (i) =>
    first === last ?
      (PLOT.left + W - PLOT.right) / 2
    : PLOT.left + ((i - first) / (last - first)) * (W - PLOT.right - PLOT.left);

  for (const v of TICKS.filter((t) => t > lo && t < hi)) {
    if (v !== 1 && v !== goal)
      out.push(
        `<line x1="${PLOT.left}" y1="${r1(y(v))}" x2="${W - PLOT.right}" y2="${r1(y(v))}" stroke="${theme.grid}" stroke-width="1"/>`
      );
    out.push(
      text(
        PLOT.left - 8,
        y(v) + 4,
        tickLabel(v),
        `font-size="11" text-anchor="end" fill="${theme.muted}" style="font-variant-numeric: tabular-nums"`
      )
    );
  }
  // The two reference lines, labelled in the right margin, clear of the data.
  const reference = (v, width, label) =>
    out.push(
      `<line x1="${PLOT.left}" y1="${r1(y(v))}" x2="${W - PLOT.right}" y2="${r1(y(v))}" stroke="${theme.baseline}" stroke-width="${width}"/>`,
      text(
        W - PLOT.right + 10,
        y(v) + 4,
        label,
        `font-size="11" fill="${theme.muted}"`
      )
    );
  reference(goal, 1, `goal: ${goal}× ${chart.above}`);
  reference(1, 1.5, "InMemoryCache");

  // X labels: the first and the last run, and runs between wherever a label
  // clears its neighbours.
  const span = last - first;
  const gap = 96;
  let previous = -Infinity;
  for (let i = first; i <= last; i++) {
    const isEnd = i === first || i === last;
    if (!isEnd && (x(i) - previous < gap || x(last) - x(i) < gap)) continue;
    previous = x(i);
    const anchor =
      span === 0 ? "middle"
      : i === first ? "start"
      : i === last ? "end"
      : "middle";
    out.push(
      text(
        x(i),
        PLOT.bottom + 22,
        runs[i].date.slice(0, 10),
        `font-size="11" text-anchor="${anchor}" fill="${theme.muted}"`
      )
    );
    if (isEnd)
      out.push(
        text(
          x(i),
          PLOT.bottom + 38,
          runs[i].sha.slice(0, 7),
          `font-size="11" text-anchor="${anchor}" fill="${theme.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace"`
        )
      );
  }

  // Series, the overall one drawn last so it stays on top. Markers on every
  // run while there are few; afterwards only at the latest.
  const sparse = runs.length - first <= 12;
  const order = series.map((s, k) => ({ ...s, k })).reverse();
  for (const s of order) {
    const colour = theme.series[s.k];
    if (s.points.length > 1)
      out.push(
        `<path d="${s.points.map((p, j) => `${j ? "L" : "M"}${r1(x(p.i))},${r1(y(p.value))}`).join("")}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      );
    const marked = sparse ? s.points : s.points.slice(-1);
    for (const p of marked)
      out.push(
        `<circle cx="${r1(x(p.i))}" cy="${r1(y(p.value))}" r="4" fill="${colour}" stroke="${theme.surface}" stroke-width="2"><title>${esc(`${s.name}, ${runs[p.i].date.slice(0, 10)} ${runs[p.i].sha.slice(0, 7)}: ${fmtX(p.value)} (${p.count} measurements)`)}</title></circle>`
      );
  }

  out.push("</svg>");
  return out.join("\n") + "\n";
}

export const CHART_FILES = [SPEED, MEMORY].flatMap((c) => [
  `charts/${c.file}.svg`,
  `charts/${c.file}-dark.svg`,
]);

/** Writes `charts/{speed,memory}{,-dark}.svg` under `dir`. */
export function writeCharts(dir, runs) {
  mkdirSync(join(dir, "charts"), { recursive: true });
  for (const chart of [SPEED, MEMORY]) {
    writeFileSync(
      join(dir, "charts", `${chart.file}.svg`),
      renderChart(runs, chart, "light")
    );
    writeFileSync(
      join(dir, "charts", `${chart.file}-dark.svg`),
      renderChart(runs, chart, "dark")
    );
  }
}

export const CHARTS = { speed: SPEED, memory: MEMORY };
