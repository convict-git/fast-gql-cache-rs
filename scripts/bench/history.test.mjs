import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { append, lastSha } from "./history.mjs";

const summary = (sha, date, rs) => ({
  date,
  sha,
  node: "v24.21.0",
  platform: "linux/x64",
  runs: 3,
  quick: false,
  wasmBytes: 14238,
  geomeanVsApollo: rs / 100,
  measurements: { "write N=10": { apollo: 100, rs } },
});

test("appends runs and regenerates the README and trend page", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bench-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(lastSha(dir), null);
  append(dir, summary("a".repeat(40), "2026-09-26T03:00:00.000Z", 100));
  append(dir, summary("b".repeat(40), "2026-09-27T03:00:00.000Z", 80));

  const lines = readFileSync(join(dir, "history.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lastSha(dir), "b".repeat(40));

  const readme = readFileSync(join(dir, "README.md"), "utf8");
  assert.match(
    readme,
    /Latest: `bbbbbbb` \(2026-09-27\): InMemoryCacheRs ÷ InMemoryCache = \*\*0\.80×\*\*/
  );
  // Newest first in the run table.
  assert.ok(
    readme.indexOf("`bbbbbbb`", readme.indexOf("| Date")) <
      readme.indexOf("`aaaaaaa`", readme.indexOf("| Date"))
  );
  assert.ok(existsSync(join(dir, "index.html")));
});
