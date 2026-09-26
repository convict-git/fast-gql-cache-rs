import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PROBE_FILES = [
  "cache-performance-probe.mjs",
  "cache-memory-probe.mjs",
  "memory-harness.mjs",
  "select-cache.mjs",
];

/**
 * A base checkout the way pr.mjs prepares one: this build (optionally made
 * to log on every construction) plus a copy of the head's probe files.
 */
function makeBase(dir, { noisy = false, probe = (source) => source } = {}) {
  const base = join(dir, "base");
  cpSync(join(REPO, "dist"), join(base, "dist"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(base, "node_modules"));
  symlinkSync(join(REPO, "pkg"), join(base, "pkg"));
  mkdirSync(join(base, "docs/probes"), { recursive: true });
  for (const file of PROBE_FILES) {
    const source = readFileSync(join(REPO, "docs/probes", file), "utf8");
    writeFileSync(join(base, "docs/probes", file), probe(source, file));
  }
  if (noisy) {
    const file = join(base, "dist/InMemoryCacheRs.js");
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("    init() {"));
    writeFileSync(
      file,
      source.replace(
        "    init() {",
        '    init() {\n        console.log("noisy");'
      )
    );
  }
  return base;
}

function runBench(dir, base, extra = ["--sections=10"]) {
  const out = join(dir, "result.json");
  const child = spawnSync(
    process.execPath,
    [
      join(REPO, "scripts/bench/run.mjs"),
      "--out",
      out,
      "--base-root",
      base,
      ...extra,
      "--runs=1",
      "--quick",
    ],
    { encoding: "utf8" }
  );
  return { child, out };
}

test("a base build that writes to stdout is still measured", (t) => {
  // Older builds logged from the WASM on every construction; the probe's
  // results must not share a channel with whatever the cache prints.
  const dir = mkdtempSync(join(tmpdir(), "bench-noisy-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { child, out } = runBench(dir, makeBase(dir, { noisy: true }));
  assert.equal(child.status, 0, child.stderr);
  const { samples } = JSON.parse(readFileSync(out, "utf8"));
  const [first] = Object.values(samples);
  assert.deepEqual(Object.keys(first).sort(), [
    "apollo@base",
    "apollo@head",
    "rs@base",
    "rs@head",
  ]);
});

test("a base checkout must run the same probe as head", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bench-other-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = makeBase(dir, {
    probe: (source, file) =>
      file === "cache-performance-probe.mjs" ?
        `${source}\n// changed\n`
      : source,
  });
  const { child } = runBench(dir, base);
  assert.notEqual(child.status, 0);
  assert.match(
    child.stderr,
    /docs\/probes\/cache-performance-probe\.mjs differs from head's/
  );
});

test("the memory probe runs through the same pipeline, with units and checks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bench-memory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { child, out } = runBench(dir, makeBase(dir), [
    "--probe=memory",
    "--sections=6",
  ]);
  assert.equal(child.status, 0, child.stderr);
  const { meta, samples, checks } = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(meta.probe, "memory");
  const labels = Object.keys(samples);
  assert.ok(labels.length > 0);
  for (const label of labels) {
    assert.equal(meta.units[label], "B");
    assert.deepEqual(Object.keys(samples[label]).sort(), [
      "apollo@base",
      "apollo@head",
      "rs@base",
      "rs@head",
    ]);
  }
  const checkLabels = Object.keys(checks);
  assert.ok(checkLabels.length > 0);
  for (const label of checkLabels) {
    for (const runs of Object.values(checks[label])) {
      assert.ok(runs.every((pass) => typeof pass === "boolean"));
    }
  }
});

test("an unknown --probe is rejected with the accepted values", () => {
  const child = spawnSync(
    process.execPath,
    [
      join(REPO, "scripts/bench/run.mjs"),
      "--out",
      "unused.json",
      "--probe=bogus",
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 2);
  assert.match(child.stderr, /use --probe=performance or --probe=memory/);
});
