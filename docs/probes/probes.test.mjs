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
