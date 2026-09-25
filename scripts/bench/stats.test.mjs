import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, geomean, median, noiseBand } from "./stats.mjs";

test("median of odd and even sample counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("geomean of ratios", () => {
  assert.equal(geomean([2, 0.5]), 1);
  assert.equal(geomean([1, 4]), 2);
});

test("noise band is the 90th percentile (nearest rank) of the A/A deviation", () => {
  // |ln ratio| sorted: 0, .00995, .01005, .0198, .0202, .0296, .0305, .0392,
  // .0513 (0.95), .0953 (1.10). Nearest rank ceil(0.9 * 10) = 9th -> 0.95.
  const aa = [1.02, 0.98, 1.1, 0.95, 1.01, 1.0, 0.99, 1.03, 1.04, 0.97];
  assert.ok(Math.abs(noiseBand(aa) - Math.log(1 / 0.95)) < 1e-12);
});

test("a change is significant only beyond the band and with no overlap", () => {
  const base = [100, 102, 101, 99, 100];
  const band = Math.log(1.05);

  assert.deepEqual(classify(base, [80, 81, 79, 82, 80], band), {
    ratio: 0.8,
    verdict: "faster",
  });
  assert.deepEqual(classify(base, [120, 121, 119, 122, 120], band), {
    ratio: 1.2,
    verdict: "slower",
  });
  // Median 108 is beyond the band, but the runs overlap (98 < base max 102).
  assert.equal(classify(base, [98, 108, 107, 110, 112], band).verdict, "noise");
  // No overlap, but 0.9x is inside a 20% band.
  assert.equal(
    classify(base, [90, 91, 89, 92, 90], Math.log(1.2)).verdict,
    "noise"
  );
});
