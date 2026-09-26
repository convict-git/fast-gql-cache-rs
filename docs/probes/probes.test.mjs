/**
 * Tests for the probe tooling itself: cache selection and the A/B report.
 * Behaviour parity is checked by `parity.mjs` (`npm run probe:parity`).
 *
 *   node --test docs/probes/probes.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const probe = (name) => fileURLToPath(new URL(name, import.meta.url));

function runNode(args, env = {}) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 600_000,
  });
}

test("an unknown --cache value is rejected with the accepted values", () => {
  const child = runNode([probe("cache-behavior-probe.mjs"), "--cache=bogus"]);
  assert.notEqual(child.status, 0);
  assert.match(
    child.stderr,
    /Unknown --cache=bogus; use --cache=apollo or --cache=rs/
  );
});

test("--cache=rs without a built dist/ says how to build it", (t) => {
  // A copy of the repository layout that shares node_modules and pkg/ but has
  // no dist/, so the real probe runs against a genuinely missing build.
  const root = mkdtempSync(join(tmpdir(), "probe-no-dist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  symlinkSync(join(repo, "pkg"), join(root, "pkg"));
  mkdirSync(join(root, "docs/probes"), { recursive: true });
  for (const file of ["select-cache.mjs", "cache-behavior-probe.mjs"]) {
    copyFileSync(probe(file), join(root, "docs/probes", file));
  }

  const child = runNode([
    join(root, "docs/probes/cache-behavior-probe.mjs"),
    "--cache=rs",
  ]);
  assert.notEqual(child.status, 0);
  assert.match(
    child.stderr,
    /InMemoryCacheRs is not built: run `npm run build:ts`/
  );
});

test("FAST_GQL_CACHE_RS_ROOT loads InMemoryCacheRs from another checkout", (t) => {
  // Another "checkout" holding this repository's build, so the probe can only
  // pass by loading InMemoryCacheRs from there.
  const root = mkdtempSync(join(tmpdir(), "probe-other-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  for (const dir of ["node_modules", "pkg", "dist"]) {
    symlinkSync(join(repo, dir), join(root, dir));
  }

  const child = runNode(
    [
      "--conditions=development",
      probe("cache-behavior-probe.mjs"),
      "--cache=rs",
    ],
    { FAST_GQL_CACHE_RS_ROOT: root }
  );
  assert.equal(child.status, 0, child.stderr);
  assert.ok(
    child.stderr.includes(`cache under test: InMemoryCacheRs from ${root}`),
    child.stderr
  );
});

test("the A/B report times every measurement against both caches", () => {
  const section = ["--quick", "--sections=1"];
  // The probe's own label list for the section is the oracle for the report.
  const apollo = runNode([
    "--expose-gc",
    probe("cache-performance-probe.mjs"),
    "--json",
    ...section,
  ]);
  assert.equal(apollo.status, 0, apollo.stderr);
  const labels = JSON.parse(apollo.stdout).results.map((r) => r.label);
  assert.ok(labels.length > 0);

  const report = runNode([probe("compare-caches.mjs"), "--json", ...section]);
  assert.equal(report.status, 0, report.stderr);
  const { rows } = JSON.parse(report.stdout);
  assert.deepEqual(
    rows.map((r) => r.label),
    labels
  );
  for (const { label, apolloNs, rsNs, ratio } of rows) {
    assert.ok(apolloNs > 0 && rsNs > 0, `missing timing for ${label}`);
    assert.equal(ratio, rsNs / apolloNs);
  }
});

test("a saved run only re-renders against the cache it measured", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "probe-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = join(dir, "agg.json");
  const perf = probe("cache-performance-probe.mjs");
  const section = ["--quick", "--sections=10"];

  const save = runNode([
    "--expose-gc",
    perf,
    ...section,
    "--runs=1",
    "--cache=rs",
    `--save=${saved}`,
  ]);
  assert.equal(save.status, 0, save.stderr);

  const same = runNode([
    "--expose-gc",
    perf,
    ...section,
    `--load=${saved}`,
    "--cache=rs",
  ]);
  assert.equal(same.status, 0, same.stderr);

  const other = runNode(["--expose-gc", perf, ...section, `--load=${saved}`]);
  assert.notEqual(other.status, 0);
  assert.match(
    other.stderr,
    /was measured with --cache=rs; pass the same flag/
  );
});

test("the memory probe measures the same bytes and checks against both caches", () => {
  const measure = (cache) => {
    const child = runNode([
      "--expose-gc",
      probe("cache-memory-probe.mjs"),
      "--json",
      "--quick",
      "--sections=6",
      `--cache=${cache}`,
    ]);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const apollo = measure("apollo");
  const rs = measure("rs");
  assert.equal(apollo.meta.wasm, null);
  assert.ok(
    rs.meta.wasm.linearBytes > 0,
    "InMemoryCacheRs reports its WASM heap"
  );
  assert.deepEqual(
    rs.results.map((r) => r.label),
    apollo.results.map((r) => r.label)
  );
  assert.deepEqual(
    rs.checks.map((c) => c.label),
    apollo.checks.map((c) => c.label)
  );
  for (const r of [...apollo.results, ...rs.results]) {
    assert.equal(r.unit, "B");
    assert.ok(r.value > 0, `${r.label}: ${r.value}`);
  }
});

test("the memory probe refuses to run without --expose-gc", () => {
  const child = runNode([probe("cache-memory-probe.mjs"), "--sections=6"]);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /needs --expose-gc/);
});
