/**
 * Behaviour parity: runs the behaviour probe against Apollo's `InMemoryCache`
 * and against `InMemoryCacheRs`, and fails unless their outputs are identical
 * (every check, and every printed store snapshot). Apollo's output is the oracle.
 *
 *   npm run probe:parity     (builds dist/ first)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(
  new URL("cache-behavior-probe.mjs", import.meta.url)
);

function runProbe(cache) {
  const child = spawnSync(
    process.execPath,
    ["--conditions=development", PROBE, `--cache=${cache}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (child.error) throw child.error;
  return child;
}

const apollo = runProbe("apollo");
const rs = runProbe("rs");

if (!/cache under test: InMemoryCacheRs\b/.test(rs.stderr)) {
  console.error(
    `The --cache=rs run did not load InMemoryCacheRs:\n${rs.stderr}`
  );
  process.exit(1);
}
if (apollo.status !== 0) {
  console.error(
    "The behaviour probe fails against Apollo's own InMemoryCache, so it is no " +
      `longer a valid oracle (exit ${apollo.status}):\n${apollo.stdout.slice(-2000)}`
  );
  process.exit(1);
}
if (rs.stdout === apollo.stdout && rs.status === apollo.status) {
  console.log("PARITY: InMemoryCacheRs output matches InMemoryCache");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "cache-parity-"));
const [a, b] = [
  join(dir, "InMemoryCache.out"),
  join(dir, "InMemoryCacheRs.out"),
];
writeFileSync(a, apollo.stdout);
writeFileSync(b, rs.stdout);
const diff = spawnSync("diff", ["-u", a, b], { encoding: "utf8" });
console.log(diff.stdout);
console.log(
  `PARITY FAILED: InMemoryCacheRs output differs from InMemoryCache (exit ${rs.status} vs ${apollo.status}).\nFull outputs: ${dir}`
);
process.exit(1);
