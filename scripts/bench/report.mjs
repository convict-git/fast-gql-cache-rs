/**
 * Turns one or more `run.mjs` results (one per parallel section group) into
 * the benchmark comment, and a compact summary for the history.
 *
 *   node scripts/bench/report.mjs results/*.json [--out comment.md]
 *        [--summary summary.json] [--run-url URL] [--base-note TEXT]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { classify, geomean, median, noiseBand } from "./stats.mjs";

export const MARKER = "<!-- fast-gql-cache-rs:benchmark -->";

export function analyze(results) {
  const [first] = results;
  const meta = {
    ...first.meta,
    sections: results.flatMap((r) => r.meta.sections).sort((a, b) => a - b),
  };
  const samples = Object.assign({}, ...results.map((r) => r.samples));
  const hasBase = Boolean(meta.base);
  const labels = Object.keys(samples);

  const band =
    hasBase ?
      noiseBand(
        labels.map(
          (l) =>
            median(samples[l]["apollo@head"]) /
            median(samples[l]["apollo@base"])
        )
      )
    : null;

  const rows = labels.map((label) => {
    const s = samples[label];
    const row = {
      label,
      apollo: median(s["apollo@head"]),
      rs: median(s["rs@head"]),
    };
    row.vsApollo = row.rs / row.apollo;
    if (hasBase) {
      row.rsBase = median(s["rs@base"]);
      row.aa = median(s["apollo@head"]) / median(s["apollo@base"]);
      Object.assign(row, classify(s["rs@base"], s["rs@head"], band));
    }
    return row;
  });

  return {
    meta,
    hasBase,
    band,
    rows,
    geomeanVsApollo: geomean(rows.map((r) => r.vsApollo)),
  };
}

const fmtNs = (ns) =>
  ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms`
  : ns >= 1e3 ? `${(ns / 1e3).toFixed(1)} µs`
  : `${Math.round(ns)} ns`;
const fmtPct = (ratio) =>
  `${ratio >= 1 ? "+" : "−"}${(Math.abs(ratio - 1) * 100).toFixed(1)}%`;
const fmtKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const short = (sha) => (sha ? `\`${sha.slice(0, 7)}\`` : "(uncommitted)");
const cell = (text) => text.replaceAll("|", "\\|");

export function render(a, { runUrl, baseNote } = {}) {
  const { meta, rows } = a;
  const lines = [MARKER];

  if (a.hasBase) {
    const count = (v) => rows.filter((r) => r.verdict === v).length;
    lines.push(
      `### Performance: ${short(meta.head.sha)} vs base ${short(meta.base.sha)}`,
      "",
      "| | |",
      "| --- | --- |",
      `| **This PR** (InMemoryCacheRs, head vs base) | **${count("faster")} faster · ${count("slower")} slower** · ${count("noise")} within noise |`,
      `| **Noise band** (InMemoryCache, identical on both sides, measured twice) | ±${((Math.exp(a.band) - 1) * 100).toFixed(1)}% |`,
      `| **InMemoryCacheRs ÷ InMemoryCache** (head, geometric mean of ${rows.length}) | ${a.geomeanVsApollo.toFixed(2)}× |`,
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
            `| ${cell(r.label)} | ${fmtNs(r.rsBase)} | ${fmtNs(r.rs)} | ${fmtPct(r.ratio)} ${r.verdict} |`
        ),
        ""
      );
    } else {
      lines.push("No InMemoryCacheRs measurement changed beyond noise.", "");
    }
    lines.push(
      `<details><summary>All ${rows.length} measurements</summary>`,
      "",
      "| Measurement | Rs base | Rs head | Change | Rs ÷ Apollo | Apollo A/A |",
      "| --- | --: | --: | --: | --: | --: |",
      ...rows.map(
        (r) =>
          `| ${cell(r.label)} | ${fmtNs(r.rsBase)} | ${fmtNs(r.rs)} | ${fmtPct(r.ratio)}${r.verdict === "noise" ? "" : ` ${r.verdict}`} | ${r.vsApollo.toFixed(2)}× | ${r.aa.toFixed(2)}× |`
      ),
      "",
      "</details>",
      ""
    );
  } else {
    lines.push(
      `### Performance: ${short(meta.head.sha)}`,
      "",
      ...((baseNote ?? meta.baseNote) ?
        [`Base not measured: ${baseNote ?? meta.baseNote}.`, ""]
      : []),
      `**InMemoryCacheRs ÷ InMemoryCache** (geometric mean of ${rows.length}): ${a.geomeanVsApollo.toFixed(2)}× · **WASM size** ${fmtKiB(meta.head.wasmBytes)}`,
      "",
      `<details><summary>All ${rows.length} measurements</summary>`,
      "",
      "| Measurement | InMemoryCache | InMemoryCacheRs | Rs ÷ Apollo |",
      "| --- | --: | --: | --: |",
      ...rows.map(
        (r) =>
          `| ${cell(r.label)} | ${fmtNs(r.apollo)} | ${fmtNs(r.rs)} | ${r.vsApollo.toFixed(2)}× |`
      ),
      "",
      "</details>",
      ""
    );
  }

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
    measurements: Object.fromEntries(
      a.rows.map((r) => [r.label, { apollo: r.apollo, rs: r.rs }])
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
