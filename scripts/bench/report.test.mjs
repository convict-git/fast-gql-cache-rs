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
