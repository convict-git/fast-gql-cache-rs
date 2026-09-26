/**
 * Tests for the memory probe's measurement primitives, against allocations of
 * known size: a probe that misreads memory would mislead every comparison
 * built on it.
 *
 *   node --test docs/probes/memory-harness.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";

// The harness needs `gc()`; the test runner does not pass --expose-gc.
v8.setFlagsFromString("--expose-gc");
globalThis.gc ??= runInNewContext("gc");

const { allocation, drop, footprint, hold, settle, slope, snapshot, use } =
  await import("./memory-harness.mjs");

/** Two-field objects: 40 bytes each on 64-bit V8 without pointer compression. */
const makeObjects = (n) => {
  const list = new Array(n);
  for (let i = 0; i < n; i++) list[i] = { a: i, b: i };
  return list;
};

test("allocation counts short-lived objects, across garbage collections", () => {
  const churn = (n) => () => {
    let last;
    for (let i = 0; i < n; i++) last = { a: i, b: i };
    return last;
  };
  const small = allocation(churn(1e6));
  const large = allocation(churn(4e6));
  assert.ok(large.gcCount > 0, "the larger run should trigger collections");
  // At least 16 bytes per object on any V8 layout, and linear in the count.
  assert.ok(small.total >= 16 * 1e6, `${small.total} bytes for 1e6 objects`);
  const perObject = large.total / 4e6;
  assert.ok(
    Math.abs(perObject - small.total / 1e6) / perObject < 0.05,
    `per-object cost differs: ${small.total / 1e6} vs ${perObject}`
  );
  assert.ok(
    Math.abs(allocation(churn(4e6)).total - large.total) / large.total < 0.02
  );
});

test("retained bytes follow what is held, and return when it is dropped", async () => {
  await settle();
  const before = snapshot();
  const id = hold(() => makeObjects(2e5));
  await settle();
  const held = footprint(before, snapshot());
  assert.ok(held.total >= 2e5 * 24, `${held.total} bytes for 2e5 objects`);
  assert.equal(
    use(id, (list) => list.length),
    2e5
  );

  drop(id);
  await settle();
  const after = footprint(before, snapshot());
  assert.ok(
    after.total < 128 * 1024,
    `${after.total} bytes still retained after dropping`
  );
});

test("external memory is counted: an ArrayBuffer is its byte length", async () => {
  await settle();
  const before = snapshot();
  const id = hold(() => new ArrayBuffer(4 * 1024 * 1024));
  await settle();
  const { total, externalOther } = footprint(before, snapshot());
  assert.ok(
    Math.abs(externalOther - 4 * 1024 * 1024) < 64 * 1024,
    `${externalOther}`
  );
  assert.ok(total >= 4 * 1024 * 1024);
  drop(id);
});

test("slope is the least-squares gradient", () => {
  assert.equal(slope([1, 2, 3, 4], [10, 20, 30, 40]), 10);
  assert.equal(slope([1, 2, 3], [5, 5, 5]), 0);
  assert.equal(slope([2, 2], [1, 9]), 0);
});
