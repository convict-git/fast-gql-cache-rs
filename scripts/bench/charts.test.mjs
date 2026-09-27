import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHARTS,
  memoryKind,
  renderChart,
  seriesPoints,
  speedCategory,
} from "./charts.mjs";

const run = (sha, date, measurements) => ({
  date,
  sha,
  node: "v24.21.0",
  wasmBytes: 14238,
  geomeanVsApollo: 1,
  measurements,
});

test("sorts performance labels into writes, reads, broadcasts and the rest", () => {
  const cases = {
    "write cold N=100": "write",
    "rewrite identical normalized N=100": "write",
    "overwrite 100 existing entities": "write",
    "prod-build write N=5000": "write",
    "read after 1 dirty N=1000": "read",
    "optimistic read through 4 layers": "read",
    "warm optimistic diff": "read",
    "broadcast 50 identical watches": "broadcast",
    "100 separate writes (100 broadcasts)": "broadcast",
    "evict 1 of 1000": "other",
    "unwind 4 layers LIFO": "other",
  };
  for (const [label, category] of Object.entries(cases))
    assert.equal(speedCategory(label), category, label);
});

test("tells retained footprints from allocations by the stage separator", () => {
  assert.equal(memoryKind("breadth N=1000: store after write"), "retained");
  assert.equal(
    memoryKind(
      "rolling window: 5 live pages of 100, write + read + evict + gc per page"
    ),
    "retained"
  );
  assert.equal(memoryKind("write cold N=5000"), "allocated");
  assert.equal(
    memoryKind("100 single-field writes in one batch, 1 watch, N=5000"),
    "allocated"
  );
});

test("plots InMemoryCache ÷ InMemoryCacheRs, so higher is better", () => {
  const runs = [
    run("a".repeat(40), "2026-09-26T03:00:00.000Z", {
      "write cold N=100": { apollo: 200, rs: 100, unit: "ns" },
      "read warm N=100": { apollo: 100, rs: 200, unit: "ns" },
    }),
    run("b".repeat(40), "2026-09-27T03:00:00.000Z", {
      "write cold N=100": { apollo: 400, rs: 100, unit: "ns" },
      "read warm N=100": { apollo: 100, rs: 100, unit: "ns" },
      "breadth N=1000: store after write": { apollo: 300, rs: 100, unit: "B" },
      "write cold N=5000": { apollo: 0, rs: 10, unit: "B" },
    }),
  ];
  const values = (s) => s.points.map((p) => Number(p.value.toFixed(9)));
  const [all, writes, reads, broadcasts] = seriesPoints(runs, CHARTS.speed);
  assert.deepEqual(values(all), [1, 2]);
  assert.deepEqual(values(writes), [2, 4]);
  assert.deepEqual(values(reads), [0.5, 1]);
  assert.deepEqual(broadcasts.points, []);

  // Memory appears from the run that first recorded it; a zero is skipped.
  const [memory] = seriesPoints(runs, CHARTS.memory);
  assert.deepEqual(
    memory.points.map((p) => p.i),
    [1]
  );
  assert.deepEqual(values(memory), [3]);

  const svg = renderChart(runs, CHARTS.speed, "dark");
  assert.match(svg, /^<svg [^>]*role="img"/);
  assert.match(svg, /All timings <tspan[^>]*>2\.00×<\/tspan>/);
  assert.match(svg, /Broadcasts <tspan[^>]*>—<\/tspan>/);
  assert.match(svg, /InMemoryCache<\/text>/);
  assert.match(svg, /bbbbbbb/);
  assert.match(svg, /<\/svg>\n$/);
});

test("renders a chart with no data yet", () => {
  const runs = [
    run("a".repeat(40), "2026-09-26T03:00:00.000Z", {
      "write cold N=100": { apollo: 200, rs: 100 },
    }),
  ];
  const svg = renderChart(runs, CHARTS.memory, "light");
  assert.match(svg, /No runs recorded yet\./);
  assert.doesNotMatch(svg, /<path/);
});
