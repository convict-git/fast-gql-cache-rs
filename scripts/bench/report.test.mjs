import assert from "node:assert/strict";
import { test } from "node:test";

import { analyze, render } from "./report.mjs";

const meta = (base) => ({
  schema: 1,
  date: "2026-09-26T00:00:00.000Z",
  node: "v24.21.0",
  platform: "linux/x64",
  runs: 3,
  quick: false,
  sections: [1],
  head: { root: "/h", sha: "b".repeat(40), wasmBytes: 2048 },
  base: base ? { root: "/b", sha: "a".repeat(40), wasmBytes: 1024 } : null,
});

// Apollo is steady on both sides (A/A 1.00x), so the band is ~0 and any
// separated change counts.
const steady = [100, 101, 99];
const result = {
  meta: meta(true),
  samples: {
    "write N=10": {
      "apollo@base": steady,
      "apollo@head": steady,
      "rs@base": [200, 201, 199],
      "rs@head": [100, 101, 99],
    },
    "read N=10": {
      "apollo@base": steady,
      "apollo@head": steady,
      "rs@base": [100, 101, 99],
      "rs@head": [150, 151, 149],
    },
    "evict N=10": {
      "apollo@base": steady,
      "apollo@head": steady,
      "rs@base": [100, 105, 95],
      "rs@head": [101, 104, 96],
    },
  },
};

test("verdicts, counts and the Rs/Apollo ratio for a PR comparison", () => {
  const a = analyze([result]);
  assert.deepEqual(
    a.rows.map((r) => [r.label, r.verdict]),
    [
      ["write N=10", "faster"],
      ["read N=10", "slower"],
      ["evict N=10", "noise"],
    ]
  );
  // Head Rs / head Apollo medians: 100/100, 150/100, 101/100.
  assert.ok(Math.abs(a.geomeanVsApollo - Math.cbrt(1 * 1.5 * 1.01)) < 1e-12);

  const md = render(a, { runUrl: "https://example.test/run/1" });
  assert.match(md, /^<!-- fast-gql-cache-rs:benchmark -->/);
  assert.match(md, /1 faster · 1 slower/);
  assert.match(md, /1 within noise/);
  assert.match(md, /`bbbbbbb` vs base `aaaaaaa`/);
  assert.match(md, /1\.0 KiB → 2\.0 KiB \(\+100\.0%\)/);
  assert.match(md, /https:\/\/example\.test\/run\/1/);
});

test("merges results from parallel section groups", () => {
  const [first, second] = Object.entries(result.samples);
  const a = analyze([
    {
      meta: { ...meta(true), sections: [1] },
      samples: Object.fromEntries([first]),
    },
    {
      meta: { ...meta(true), sections: [2] },
      samples: Object.fromEntries([second]),
    },
  ]);
  assert.deepEqual(
    a.rows.map((r) => r.label),
    ["write N=10", "read N=10"]
  );
  assert.deepEqual(a.meta.sections, [1, 2]);
});

test("without a base it reports only InMemoryCacheRs vs InMemoryCache", () => {
  const headOnly = {
    meta: meta(false),
    samples: {
      "write N=10": { "apollo@head": [100, 100, 100], "rs@head": [80, 80, 80] },
    },
  };
  const a = analyze([headOnly]);
  assert.equal(a.hasBase, false);
  assert.equal(a.geomeanVsApollo, 0.8);
  const md = render(a, { baseNote: "the base build failed" });
  assert.match(md, /Base not measured: the base build failed/);
  assert.match(md, /0\.80×/);
});

const memoryResult = {
  meta: {
    ...meta(true),
    probe: "memory",
    units: { "retained N=10": "B", "allocated N=10": "B" },
  },
  samples: {
    "retained N=10": {
      "apollo@base": [1000, 1000, 1000],
      "apollo@head": [1000, 1000, 1000],
      "rs@base": [2000, 2000, 2000],
      "rs@head": [1000, 1001, 999],
    },
    "allocated N=10": {
      "apollo@base": [4096, 4096, 4096],
      "apollo@head": [4096, 4096, 4096],
      "rs@base": [4096, 4096, 4096],
      "rs@head": [8192, 8193, 8191],
    },
  },
  checks: {
    "memory plateaus": {
      "apollo@base": [false],
      "apollo@head": [false],
      "rs@base": [true],
      "rs@head": [false],
    },
    "drop returns memory": {
      "apollo@base": [true],
      "apollo@head": [true],
      "rs@base": [true],
      "rs@head": [true],
    },
  },
};

test("memory results get their own family, noise band, verdicts and checks", () => {
  const a = analyze([result, memoryResult]);
  // Timings keep their own summary; memory is summarized separately.
  assert.ok(Math.abs(a.geomeanVsApollo - Math.cbrt(1 * 1.5 * 1.01)) < 1e-12);
  assert.ok(Math.abs(a.memoryGeomeanVsApollo - Math.sqrt(1 * 2)) < 1e-3);
  assert.deepEqual(
    a.families.B.rows.map((r) => [r.label, r.verdict]),
    [
      ["retained N=10", "faster"],
      ["allocated N=10", "slower"],
    ]
  );
  assert.deepEqual(
    a.checks.map((c) => [c.label, c.rs, c.regressed]),
    [
      ["memory plateaus", false, true],
      ["drop returns memory", true, false],
    ]
  );

  const md = render(a);
  assert.match(md, /### Performance: `bbbbbbb` vs base `aaaaaaa`/);
  assert.match(md, /### Memory: `bbbbbbb` vs base `aaaaaaa`/);
  assert.match(md, /1 smaller · 1 larger/);
  assert.match(
    md,
    /\| retained N=10 \| 2\.0 KiB \| 1000 B \| −50\.0% smaller \|/
  );
  assert.match(md, /#### Memory checks/);
  assert.match(md, /1 check\(s\) passed on the base and fail on this PR/);
  assert.match(
    md,
    /memory plateaus \(\*\*regressed\*\*\) \| \*\*fail\*\* \| pass \| \*\*fail\*\*/
  );
  // Timings still come first, then memory, then the checks.
  assert.ok(md.indexOf("### Performance") < md.indexOf("### Memory"));
  assert.ok(md.indexOf("### Memory") < md.indexOf("#### Memory checks"));
});

test("a zero memory value has no ratio instead of breaking the geometric mean", () => {
  const zero = structuredClone(memoryResult);
  zero.samples["retained N=10"]["rs@head"] = [0, 0, 0];
  const a = analyze([zero]);
  const row = a.families.B.rows.find((r) => r.label === "retained N=10");
  assert.equal(row.vsApollo, null);
  assert.equal(row.verdict, "noise");
  assert.ok(Number.isFinite(a.memoryGeomeanVsApollo));
  assert.equal(a.geomeanVsApollo, null);
  assert.doesNotMatch(render(a), /NaN|Infinity/);
});
