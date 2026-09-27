/**
 * Renders the benchmark chart the repository README embeds: speed and memory
 * of InMemoryCacheRs relative to Apollo's InMemoryCache, one point per measured
 * commit in `history.jsonl`. `history.mjs` writes it to `charts/` on the
 * `dnd-data/benchmarks` branch, a light and a dark file, so the README picks
 * one with `<picture>` and updates without a commit to `main`.
 *
 * Both families share one axis because they share one measure:
 * InMemoryCache ÷ InMemoryCacheRs, so higher is better and 1× is Apollo; 2× is
 * twice as fast, or half the memory. Unlike the trend page, which plots the
 * inverse, this reads as progress at a glance. Speed lines are solid with round
 * markers, memory lines dashed with square ones, so the families differ by
 * more than colour. The chart is static SVG (GitHub serves README images
 * without scripts), so the legend carries each series' latest value as text.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** The two families and their series, in legend and colour-slot order. */
export const FAMILIES = [
  {
    name: "Speed",
    above: "faster",
    unit: (m) => m.unit !== "B",
    dash: null,
    series: [
      { name: "All timings", test: () => true },
      { name: "Writes", test: (l) => speedCategory(l) === "write" },
      { name: "Reads", test: (l) => speedCategory(l) === "read" },
      { name: "Broadcasts", test: (l) => speedCategory(l) === "broadcast" },
    ],
  },
  {
    name: "Memory",
    above: "smaller",
    unit: (m) => m.unit === "B",
    dash: "6 4",
    series: [
      { name: "All memory", test: () => true },
      { name: "Retained", test: (l) => memoryKind(l) === "retained" },
      { name: "Allocated", test: (l) => memoryKind(l) === "allocated" },
    ],
  },
];

/**
 * GitHub's own page colours, so the chart sits on the README like part of it;
 * the seven categorical slots (the dataviz palette's first seven) are
 * validated for colour-vision deficiency on both surfaces, adjacent pairs.
 */
const THEMES = {
  light: {
    surface: "#ffffff",
    border: "#d1d9e0",
    ink: "#1f2328",
    muted: "#59636e",
    grid: "#e6e9ed",
    baseline: "#818b98",
    series: [
      "#2a78d6",
      "#eb6834",
      "#1baf7a",
      "#eda100",
      "#e87ba4",
      "#008300",
      "#4a3aa7",
    ],
  },
  dark: {
    surface: "#0d1117",
    border: "#3d444d",
    ink: "#f0f6fc",
    muted: "#9198a1",
    grid: "#21262d",
    baseline: "#656c76",
    series: [
      "#3987e5",
      "#d95926",
      "#199e70",
      "#c98500",
      "#d55181",
      "#008300",
      "#9085e9",
    ],
  },
};

/**
 * One point per run for every series: the geometric mean of InMemoryCache ÷
 * InMemoryCacheRs over the run's measurements in that series.
 */
export function seriesPoints(runs) {
  return FAMILIES.flatMap((family) =>
    family.series.map((s, k) => {
      const points = [];
      runs.forEach((run, i) => {
        const ratios = Object.entries(run.measurements ?? {})
          .filter(([label, m]) => family.unit(m) && s.test(label))
          .filter(([, m]) => m.apollo > 0 && m.rs > 0)
          .map(([, m]) => m.apollo / m.rs);
        if (ratios.length)
          points.push({ i, value: geomean(ratios), count: ratios.length });
      });
      return { name: s.name, family, overall: k === 0, points };
    })
  );
}

const W = 800;
const H = 400;
const PLOT = { left: 56, right: 150, top: 128, bottom: 350 };
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

const TITLE = "InMemoryCacheRs vs InMemoryCache: speed and memory";

/** A marker: round for speed, square for memory, ringed in the surface colour. */
function marker(family, cx, cy, fill, surface, size, title = "") {
  const ring = `stroke="${surface}" stroke-width="2"`;
  const inner = title ? `<title>${esc(title)}</title>` : "";
  return family.dash ?
      `<rect x="${r1(cx - size)}" y="${r1(cy - size)}" width="${2 * size}" height="${2 * size}" rx="1.5" fill="${fill}" ${ring}>${inner}</rect>`
    : `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${size}" fill="${fill}" ${ring}>${inner}</circle>`;
}

/** The chart's SVG in one theme. */
export function renderChart(runs, themeName) {
  const theme = THEMES[themeName];
  const series = seriesPoints(runs);
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const goal = 2;

  const text = (x, y, content, attrs = "") =>
    `<text x="${r1(x)}" y="${r1(y)}" ${attrs}>${esc(content)}</text>`;
  const out = [];
  const latestRun = runs.at(-1);
  const desc =
    all.length ?
      `${series
        .filter((s) => s.points.length)
        .map((s) => {
          const last = s.points.at(-1);
          return `${s.family.name}, ${s.name}: ${fmtX(last.value)} (${last.count} measurements)`;
        })
        .join("; ")}, as of ${latestRun.date.slice(0, 10)}.`
    : "No runs recorded yet.";

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="chart-title chart-desc" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`,
    `<title id="chart-title">${esc(TITLE)}</title>`,
    `<desc id="chart-desc">InMemoryCache ÷ InMemoryCacheRs, both measured on one runner, per measured commit of main; higher is faster or smaller. ${esc(desc)}</desc>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${theme.surface}" stroke="${theme.border}"/>`,
    text(24, 34, TITLE, `font-size="16" font-weight="600" fill="${theme.ink}"`),
    text(
      24,
      56,
      "How many times faster or smaller than InMemoryCache, per measured commit of main. Higher is better.",
      `font-size="12" fill="${theme.muted}"`
    )
  );

  // Legend: a row per family, always present, carrying each series' latest
  // value. Columns line up across the rows.
  const columns = Math.max(...FAMILIES.map((f) => f.series.length));
  const slot = (W - 96 - 24) / columns;
  FAMILIES.forEach((family, row) => {
    const ly = 84 + row * 24;
    out.push(
      text(
        24,
        ly + 4,
        family.name,
        `font-size="12" font-weight="600" fill="${theme.ink}"`
      )
    );
    series
      .filter((s) => s.family === family)
      .forEach((s, k) => {
        const x = 96 + k * slot;
        const colour = theme.series[series.indexOf(s)];
        const last = s.points.at(-1);
        out.push(
          `<line x1="${r1(x)}" y1="${ly}" x2="${r1(x + 24)}" y2="${ly}" stroke="${colour}" stroke-width="2" stroke-linecap="round"${family.dash ? ` stroke-dasharray="${family.dash}"` : ""}/>`,
          marker(family, x + 12, ly, colour, theme.surface, 3.5),
          `<text x="${r1(x + 32)}" y="${ly + 4}" font-size="12" fill="${theme.muted}">${esc(s.name)} <tspan font-weight="600" fill="${theme.ink}">${last ? fmtX(last.value) : "—"}</tspan></text>`
        );
      });
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
  reference(goal, 1, `goal: ${goal}×`);
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

  // Series: the breakdowns first, then the two overall lines on top. Markers
  // on every run while there are few; afterwards only at the latest.
  const sparse = runs.length - first <= 12;
  const order = series
    .map((s, k) => ({ ...s, k }))
    .sort((a, b) => a.overall - b.overall || b.k - a.k);
  for (const s of order) {
    const colour = theme.series[s.k];
    if (s.points.length > 1)
      out.push(
        `<path d="${s.points.map((p, j) => `${j ? "L" : "M"}${r1(x(p.i))},${r1(y(p.value))}`).join("")}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.family.dash ? ` stroke-dasharray="${s.family.dash}"` : ""}/>`
      );
    const marked = sparse ? s.points : s.points.slice(-1);
    for (const p of marked)
      out.push(
        marker(
          s.family,
          x(p.i),
          y(p.value),
          colour,
          theme.surface,
          4,
          `${s.family.name}, ${s.name}, ${runs[p.i].date.slice(0, 10)} ${runs[p.i].sha.slice(0, 7)}: ${fmtX(p.value)} (${p.count} measurements)`
        )
      );
  }

  out.push("</svg>");
  return out.join("\n") + "\n";
}

export const CHART_FILES = [
  "charts/benchmarks.svg",
  "charts/benchmarks-dark.svg",
];

/**
 * Writes the chart's light and dark SVGs under `dir`, replacing whatever
 * `charts/` held, so a renamed chart leaves no stale file behind.
 */
export function writeCharts(dir, runs) {
  rmSync(join(dir, "charts"), { recursive: true, force: true });
  mkdirSync(join(dir, "charts"));
  writeFileSync(join(dir, CHART_FILES[0]), renderChart(runs, "light"));
  writeFileSync(join(dir, CHART_FILES[1]), renderChart(runs, "dark"));
}
