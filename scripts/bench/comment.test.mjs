import assert from "node:assert/strict";
import { test } from "node:test";

import { nextBody } from "./comment.mjs";
import { MARKER } from "./report.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const report = `${MARKER}\n### Performance: \`aaaaaaa\` vs base \`0000000\`\n\nresults table\n`;

test("a PR without results gets a not-benchmarked notice", () => {
  const body = nextBody(null, { kind: "status", headSha: A });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /Not benchmarked yet/);
});

test("results replace the comment and record the benchmarked commit", () => {
  const first = nextBody(null, { kind: "status", headSha: A });
  const body = nextBody(first, { kind: "results", headSha: A, report });
  assert.match(body, /results table/);
  assert.doesNotMatch(body, /Not benchmarked yet/);
  // The same commit again: nothing to update.
  assert.equal(nextBody(body, { kind: "status", headSha: A }), null);
});

test("a push after the results marks them stale, once", () => {
  const results = nextBody(null, { kind: "results", headSha: A, report });
  const stale = nextBody(results, { kind: "status", headSha: B });
  assert.match(stale, /results are for `aaaaaaa`; the PR is now at `bbbbbbb`/);
  assert.match(stale, /results table/);

  const C = "c".repeat(40);
  const again = nextBody(stale, { kind: "status", headSha: C });
  assert.equal(again.match(/results are for/g).length, 1);
  assert.match(again, /now at `ccccccc`/);
});
