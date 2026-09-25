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

// Report the first differing lines with context: enough to locate the
// divergence without an external diff tool.
const [want, got] = [apollo.stdout.split("\n"), rs.stdout.split("\n")];
const first = want.findIndex((line, i) => line !== got[i]);
const at = first === -1 ? Math.min(want.length, got.length) : first;
const context = (lines) =>
  lines
    .slice(Math.max(0, at - 3), at + 8)
    .map(
      (line, i) =>
        `  ${String(Math.max(0, at - 3) + i + 1).padStart(5)}  ${line}`
    )
    .join("\n");
const dir = mkdtempSync(join(tmpdir(), "cache-parity-"));
writeFileSync(join(dir, "InMemoryCache.out"), apollo.stdout);
writeFileSync(join(dir, "InMemoryCacheRs.out"), rs.stdout);
console.log(
  `PARITY FAILED: InMemoryCacheRs output differs from InMemoryCache from line ${at + 1} ` +
    `(exit ${rs.status} vs ${apollo.status}).\n\n` +
    `InMemoryCache:\n${context(want)}\n\nInMemoryCacheRs:\n${context(got)}\n\n` +
    `Full outputs: ${dir}`
);
process.exit(1);
