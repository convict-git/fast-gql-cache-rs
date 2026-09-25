/**
 * A/B performance report: runs the performance probe once against Apollo's
 * `InMemoryCache` and once against `InMemoryCacheRs`, and lists every
 * measurement side by side. Ratio = InMemoryCacheRs / InMemoryCache, so below
 * 1.00x means InMemoryCacheRs is faster.
 *
 *   npm run probe:compare -- --runs=5
 *   node docs/probes/compare-caches.mjs --quick --sections=1,13 [--json]
 *
 * Every other argument (`--runs`, `--quick`, `--sections`) is passed through
 * to both probe runs. Requires the built `dist/` (`npm run build:ts`).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(
  new URL("cache-performance-probe.mjs", import.meta.url)
);
const JSON_OUT = process.argv.includes("--json");
const passThrough = process.argv
  .slice(2)
  .filter((a) => a !== "--json" && !a.startsWith("--cache="));

function measure(cache) {
  if (!JSON_OUT) process.stderr.write(`measuring --cache=${cache}...\n`);
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", PROBE, "--json", `--cache=${cache}`, ...passThrough],
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
  const { meta, results } = JSON.parse(child.stdout);
  // Aggregated runs (--runs=R) report the median as `median`, single runs as `ns`.
  return { meta, ns: new Map(results.map((r) => [r.label, r.median ?? r.ns])) };
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

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { meta: { apollo: apollo.meta, rs: rs.meta }, rows },
      null,
      2
    )
  );
} else {
  const fmt = (ns) =>
    ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms`
    : ns >= 1e3 ? `${(ns / 1e3).toFixed(1)} µs`
    : `${Math.round(ns)} ns`;
  console.log(
    `${"InMemoryCache".padStart(14)} ${"InMemoryCacheRs".padStart(16)} ${"ratio".padStart(7)}  measurement`
  );
  for (const { label, apolloNs, rsNs, ratio } of rows) {
    console.log(
      `${fmt(apolloNs).padStart(14)} ${fmt(rsNs).padStart(16)} ${`${ratio.toFixed(2)}x`.padStart(7)}  ${label}`
    );
  }
  const { node, platform, runs, quick } = apollo.meta;
  console.log(
    `\n${rows.length} measurements. Node ${node} on ${platform}; runs=${runs}${quick ? ", quick" : ""}. ` +
      "Ratio < 1.00x: InMemoryCacheRs is faster."
  );
}
