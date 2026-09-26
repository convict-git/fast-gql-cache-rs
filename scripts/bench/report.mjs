/**
 * Turns one or more `run.mjs` results (one per parallel section group, from
 * either probe) into the benchmark comment, and a compact summary for the
 * history.
 *
 *   node scripts/bench/report.mjs results/*.json [--out comment.md]
 *        [--summary summary.json] [--run-url URL] [--base-note TEXT]
 *
 * Measurements come in two families by unit: timings (`ns`, the performance
 * probe) and bytes (`B`, the memory probe). Each family gets its own noise band,
 * because the two are not equally noisy, and its own section in the comment.
 * The memory probe's pass/fail checks get a table of their own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { classify, geomean, median, noiseBand } from "./stats.mjs";

export const MARKER = "<!-- fast-gql-cache-rs:benchmark -->";

/** Timings and bytes: how each family is named, formatted and judged. */
export const FAMILIES = {
  ns: {
    title: "Performance",
    better: "faster",
    worse: "slower",
    fmt: (ns) =>
      ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms`
      : ns >= 1e3 ? `${(ns / 1e3).toFixed(1)} µs`
      : `${Math.round(ns)} ns`,
  },
  B: {
    title: "Memory",
    better: "smaller",
    worse: "larger",
    fmt: (bytes) =>
      bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
      : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(2)} MiB`
      : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${Math.round(bytes)} B`,
  },
};

/** A ratio only between two positive values; memory deltas can be zero. */
const ratioOf = (a, b) => (a > 0 && b > 0 ? a / b : null);

function analyzeFamily(labels, samples, hasBase) {
  const aa = (hasBase ? labels : [])
    .map((l) =>
      ratioOf(
        median(samples[l]["apollo@head"]),
        median(samples[l]["apollo@base"])
      )
    )
    .filter((r) => r !== null);
  const band = hasBase && aa.length ? noiseBand(aa) : null;
  const rows = labels.map((label) => {
    const s = samples[label];
    const row = {
      label,
      apollo: median(s["apollo@head"]),
      rs: median(s["rs@head"]),
    };
    row.vsApollo = ratioOf(row.rs, row.apollo);
    if (hasBase) {
      row.rsBase = median(s["rs@base"]);
      row.aa = ratioOf(median(s["apollo@head"]), median(s["apollo@base"]));
      Object.assign(
        row,
        ratioOf(row.rs, row.rsBase) === null ?
          { ratio: null, verdict: "noise" }
        : classify(s["rs@base"], s["rs@head"], band)
      );
    }
    return row;
  });
  const ratios = rows.map((r) => r.vsApollo).filter((r) => r !== null);
  return { band, rows, geomean: ratios.length ? geomean(ratios) : null };
}

export function analyze(results) {
  const [first] = results;
  const meta = {
    ...first.meta,
    sections: results.flatMap((r) => r.meta.sections).sort((a, b) => a - b),
  };
  const samples = Object.assign({}, ...results.map((r) => r.samples));
  const units = Object.assign({}, ...results.map((r) => r.meta.units ?? {}));
  const checkSamples = Object.assign({}, ...results.map((r) => r.checks ?? {}));
  const hasBase = Boolean(meta.base);
  const unitOf = (label) => units[label] ?? "ns";

  const families = {};
  for (const unit of Object.keys(FAMILIES)) {
    const labels = Object.keys(samples).filter((l) => unitOf(l) === unit);
    if (labels.length) {
      families[unit] = analyzeFamily(labels, samples, hasBase);
      for (const row of families[unit].rows) row.unit = unit;
    }
  }

  const allPass = (runs) => (runs ? runs.every(Boolean) : null);
  const checks = Object.entries(checkSamples).map(([label, byKey]) => {
    const row = {
      label,
      apollo: allPass(byKey["apollo@head"]),
      rs: allPass(byKey["rs@head"]),
      rsBase: hasBase ? allPass(byKey["rs@base"]) : null,
    };
    row.regressed = hasBase && row.rsBase === true && row.rs === false;
    return row;
  });

  return {
    meta,
    hasBase,
    families,
    checks,
    // The timing family, under the names the history and earlier reports use.
    band: families.ns?.band ?? null,
    rows: Object.values(families).flatMap((f) => f.rows),
    geomeanVsApollo: families.ns?.geomean ?? null,
    memoryGeomeanVsApollo: families.B?.geomean ?? null,
  };
}

const fmtPct = (ratio) =>
  `${ratio >= 1 ? "+" : "−"}${(Math.abs(ratio - 1) * 100).toFixed(1)}%`;
const fmtX = (ratio) => (ratio === null ? "n/a" : `${ratio.toFixed(2)}×`);
const fmtKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const short = (sha) => (sha ? `\`${sha.slice(0, 7)}\`` : "(uncommitted)");
const cell = (text) => text.replaceAll("|", "\\|");
const mark = (pass) =>
  pass === null ? "—"
  : pass ? "pass"
  : "**fail**";

function renderFamily(unit, family, a, lines, note) {
  const { title, better, worse, fmt } = FAMILIES[unit];
  const { meta } = a;
  const { rows } = family;
  const verdictText = (v) =>
    v === "faster" ? better
    : v === "slower" ? worse
    : v;

  if (a.hasBase) {
    const count = (v) => rows.filter((r) => r.verdict === v).length;
    lines.push(
      `### ${title}: ${short(meta.head.sha)} vs base ${short(meta.base.sha)}`,
      "",
      "| | |",
      "| --- | --- |",
      `| **This PR** (InMemoryCacheRs, head vs base) | **${count("faster")} ${better} · ${count("slower")} ${worse}** · ${count("noise")} within noise |`,
      `| **Noise band** (InMemoryCache, identical on both sides, measured twice) | ${family.band === null ? "n/a" : `±${((Math.exp(family.band) - 1) * 100).toFixed(1)}%`} |`,
      `| **InMemoryCacheRs ÷ InMemoryCache** (head, geometric mean of ${rows.length}) | ${fmtX(family.geomean)} |`,
      `| **WASM size** | ${fmtKiB(meta.base.wasmBytes)} → ${fmtKiB(meta.head.wasmBytes)} (${fmtPct(meta.head.wasmBytes / meta.base.wasmBytes)}) |`,
      ""
    );
    const changed = rows.filter((r) => r.verdict !== "noise");
    if (changed.length) {
      lines.push(
        "#### Changes beyond noise",
        "",
        "| Measurement | Base | Head | Change |",
        "| --- | --: | --: | --: |",
        ...changed.map(
          (r) =>
            `| ${cell(r.label)} | ${fmt(r.rsBase)} | ${fmt(r.rs)} | ${fmtPct(r.ratio)} ${verdictText(r.verdict)} |`
        ),
        ""
      );
    } else {
      lines.push(
        `No InMemoryCacheRs ${title.toLowerCase()} measurement changed beyond noise.`,
        ""
      );
    }
    lines.push(
      `<details><summary>All ${rows.length} measurements</summary>`,
      "",
      "| Measurement | Rs base | Rs head | Change | Rs ÷ Apollo | Apollo A/A |",
      "| --- | --: | --: | --: | --: | --: |",
      ...rows.map(
        (r) =>
          `| ${cell(r.label)} | ${fmt(r.rsBase)} | ${fmt(r.rs)} | ${r.ratio === null ? "n/a" : fmtPct(r.ratio)}${r.verdict === "noise" ? "" : ` ${verdictText(r.verdict)}`} | ${fmtX(r.vsApollo)} | ${fmtX(r.aa)} |`
      ),
      "",
      "</details>",
      ""
    );
  } else {
    lines.push(
      `### ${title}: ${short(meta.head.sha)}`,
      "",
      ...(note ? [`Base not measured: ${note}.`, ""] : []),
      `**InMemoryCacheRs ÷ InMemoryCache** (geometric mean of ${rows.length}): ${fmtX(family.geomean)} · **WASM size** ${fmtKiB(meta.head.wasmBytes)}`,
      "",
      `<details><summary>All ${rows.length} measurements</summary>`,
      "",
      "| Measurement | InMemoryCache | InMemoryCacheRs | Rs ÷ Apollo |",
      "| --- | --: | --: | --: |",
      ...rows.map(
        (r) =>
          `| ${cell(r.label)} | ${fmt(r.apollo)} | ${fmt(r.rs)} | ${fmtX(r.vsApollo)} |`
      ),
      "",
      "</details>",
      ""
    );
  }
}

function renderChecks(a, lines) {
  const failing = a.checks.filter((c) => c.rs === false);
  const regressed = a.checks.filter((c) => c.regressed);
  lines.push(
    "#### Memory checks",
    "",
    regressed.length ?
      `**${regressed.length} check(s) passed on the base and fail on this PR.**`
    : failing.length ?
      `${failing.length} of ${a.checks.length} checks fail for InMemoryCacheRs; none regressed.`
    : `All ${a.checks.length} checks pass for InMemoryCacheRs.`,
    "",
    a.hasBase ?
      "| Check | InMemoryCache | Rs base | Rs head |"
    : "| Check | InMemoryCache | InMemoryCacheRs |",
    a.hasBase ? "| --- | :-: | :-: | :-: |" : "| --- | :-: | :-: |",
    ...a.checks.map((c) =>
      a.hasBase ?
        `| ${cell(c.label)}${c.regressed ? " (**regressed**)" : ""} | ${mark(c.apollo)} | ${mark(c.rsBase)} | ${mark(c.rs)} |`
      : `| ${cell(c.label)} | ${mark(c.apollo)} | ${mark(c.rs)} |`
    ),
    ""
  );
}

export function render(a, { runUrl, baseNote } = {}) {
  const { meta } = a;
  const lines = [MARKER];
  // Why the base is missing, stated once, under the first family's heading.
  let note = baseNote ?? meta.baseNote;
  for (const unit of Object.keys(FAMILIES)) {
    if (a.families[unit]) {
      renderFamily(unit, a.families[unit], a, lines, note);
      note = null;
    }
  }
  if (a.checks.length) renderChecks(a, lines);
  lines.push(
    `<sub>${meta.quick ? "Quick" : "Full"} precision · ${meta.runs} runs per configuration, interleaved, each section in a fresh process · Node ${meta.node} · ${meta.platform}${runUrl ? ` · [workflow run](${runUrl}) (raw JSON in its artifacts)` : ""}</sub>`
  );
  return `${lines.join("\n")}\n`;
}

/** One line of the history: everything a trend needs, without raw samples. */
export function summarize(a) {
  return {
    date: a.meta.date,
    sha: a.meta.head.sha,
    node: a.meta.node,
    platform: a.meta.platform,
    runs: a.meta.runs,
    quick: a.meta.quick,
    wasmBytes: a.meta.head.wasmBytes,
    geomeanVsApollo: a.geomeanVsApollo,
    memoryGeomeanVsApollo: a.memoryGeomeanVsApollo,
    measurements: Object.fromEntries(
      a.rows.map((r) => [r.label, { apollo: r.apollo, rs: r.rs, unit: r.unit }])
    ),
    checks: Object.fromEntries(
      a.checks.map((c) => [c.label, { apollo: c.apollo, rs: c.rs }])
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const out = opt("--out");
  const summaryOut = opt("--summary");
  const runUrl = opt("--run-url");
  const baseNote = opt("--base-note");
  const a = analyze(args.map((f) => JSON.parse(readFileSync(f, "utf8"))));
  const md = render(a, { runUrl, baseNote });
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
  if (summaryOut) {
    writeFileSync(summaryOut, `${JSON.stringify(summarize(a))}\n`);
  }
}
