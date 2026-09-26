/**
 * A/B report: runs a probe once against Apollo's `InMemoryCache` and once
 * against `InMemoryCacheRs`, and lists every measurement side by side. Ratio =
 * InMemoryCacheRs / InMemoryCache, so below 1.00x means InMemoryCacheRs is
 * faster (performance probe) or smaller (memory probe).
 *
 *   npm run probe:compare -- --runs=5
 *   npm run probe:compare -- --probe=memory --runs=3
 *   node docs/probes/compare-caches.mjs --quick --sections=1,13 [--json]
 *
 * `--probe=performance|memory` picks the probe (performance by default). Every
 * other argument (`--runs`, `--quick`, `--sections`) is passed through to both
 * probe runs. Requires the built `dist/` (`npm run build:ts`).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBES = {
  performance: "cache-performance-probe.mjs",
  memory: "cache-memory-probe.mjs",
};
const probeName =
  process.argv
    .find((a) => a.startsWith("--probe="))
    ?.slice("--probe=".length) ?? "performance";
if (!PROBES[probeName]) {
  console.error(
    `Unknown --probe=${probeName}; use --probe=performance or --probe=memory`
  );
  process.exit(2);
}
const PROBE = fileURLToPath(new URL(PROBES[probeName], import.meta.url));
const JSON_OUT = process.argv.includes("--json");
const passThrough = process.argv
  .slice(2)
  .filter(
    (a) =>
      a !== "--json" && !a.startsWith("--cache=") && !a.startsWith("--probe=")
  );

function measure(cache) {
  if (!JSON_OUT) process.stderr.write(`measuring --cache=${cache}...\n`);
  // Results come through a file: stdout also carries what the cache prints.
  const dir = mkdtempSync(join(tmpdir(), "compare-caches-"));
  const jsonFile = join(dir, "result.json");
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      PROBE,
      `--json-out=${jsonFile}`,
      `--cache=${cache}`,
      ...passThrough,
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (child.status !== 0) {
    console.error(
      `The --cache=${cache} run failed (exit ${child.status}):\n${child.stderr}`
    );
    process.exit(1);
  }
  const {
    meta,
    results,
    checks = [],
  } = JSON.parse(readFileSync(jsonFile, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  // Aggregated runs (--runs=R) report the median as `median`; single runs report
  // `ns` (performance) or `value` (memory).
  return {
    meta,
    ns: new Map(results.map((r) => [r.label, r.median ?? r.value ?? r.ns])),
    units: new Map(results.map((r) => [r.label, r.unit ?? "ns"])),
    checks,
  };
}

const apollo = measure("apollo");
const rs = measure("rs");

const rows = [...apollo.ns].map(([label, apolloNs]) => {
  const rsNs = rs.ns.get(label);
  return { label, apolloNs, rsNs, ratio: rsNs / apolloNs };
});
const missing = rows.filter((r) => r.rsNs === undefined).map((r) => r.label);
if (missing.length || rs.ns.size !== apollo.ns.size) {
  console.error(
    `The two runs measured different things; missing from rs: ${missing.join(", ")}`
  );
  process.exit(1);
}

const checkRows = apollo.checks.map((c) => ({
  label: c.label,
  apollo: c.pass,
  rs: rs.checks.find((r) => r.label === c.label)?.pass ?? null,
}));

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { meta: { apollo: apollo.meta, rs: rs.meta }, rows, checks: checkRows },
      null,
      2
    )
  );
} else {
  const fmtNs = (ns) =>
    ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms`
    : ns >= 1e3 ? `${(ns / 1e3).toFixed(1)} µs`
    : `${Math.round(ns)} ns`;
  const fmtBytes = (b) =>
    b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(2)} MiB`
    : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB`
    : `${Math.round(b)} B`;
  const fmt = (value, label) =>
    apollo.units.get(label) === "B" ? fmtBytes(value) : fmtNs(value);
  console.log(
    `${"InMemoryCache".padStart(14)} ${"InMemoryCacheRs".padStart(16)} ${"ratio".padStart(7)}  measurement`
  );
  for (const { label, apolloNs, rsNs, ratio } of rows) {
    console.log(
      `${fmt(apolloNs, label).padStart(14)} ${fmt(rsNs, label).padStart(16)} ${`${ratio.toFixed(2)}x`.padStart(7)}  ${label}`
    );
  }
  const { node, platform, runs, quick } = apollo.meta;
  console.log(
    `\n${rows.length} measurements. Node ${node} on ${platform}; runs=${runs}${quick ? ", quick" : ""}. ` +
      `Ratio < 1.00x: InMemoryCacheRs is ${probeName === "memory" ? "smaller" : "faster"}.`
  );
  for (const c of checkRows) {
    console.log(
      `check  InMemoryCache ${c.apollo ? "pass" : "FAIL"}  InMemoryCacheRs ${c.rs ? "pass" : "FAIL"}  ${c.label}`
    );
  }
}
