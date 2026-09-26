import assert from "node:assert/strict";
import { test } from "node:test";

import { assess, toStatus } from "./gate.mjs";

const run = (id, report, measured = true) => ({ id, measured, report });
const job = (status, conclusion = null) => ({ status, conclusion });

test("no benchmark label: pass", () => {
  assert.equal(assess({ labelled: false, runs: [] }).action, "pass");
});

test("labelled and this run measures: wait for its report, then follow it", () => {
  const current = 7;
  const state = (report) => ({
    labelled: true,
    currentRunId: current,
    currentMeasures: true,
    runs: [run(current, report)],
  });
  assert.deepEqual(assess(state(null)), { action: "wait", runId: current });
  assert.deepEqual(assess(state(job("in_progress"))), {
    action: "wait",
    runId: current,
  });
  assert.equal(assess(state(job("completed", "success"))).action, "pass");
  assert.equal(assess(state(job("completed", "failure"))).action, "fail");
  // Measuring failed, so the report never ran.
  assert.equal(assess(state(job("completed", "skipped"))).action, "fail");
});

test("labelled, this run does not measure: follow the run that does", () => {
  const base = { labelled: true, currentRunId: 9, currentMeasures: false };
  // Newest first: this run (report skipped), an in-flight benchmark, an old one.
  const inFlight = {
    ...base,
    runs: [
      run(9, job("completed", "skipped"), false),
      run(8, job("queued")),
      run(3, job("completed", "failure")),
    ],
  };
  assert.deepEqual(assess(inFlight), { action: "wait", runId: 8 });

  const done = {
    ...base,
    runs: [
      run(9, job("completed", "skipped"), false),
      run(8, job("completed", "success")),
    ],
  };
  assert.equal(assess(done).action, "pass");

  const none = {
    ...base,
    runs: [
      run(9, job("completed", "skipped"), false),
      run(4, job("completed", "skipped"), false),
    ],
  };
  assert.equal(assess(none).action, "fail");
});

test("a benchmark still measuring has no report job yet, and is still followed", () => {
  const state = {
    labelled: true,
    currentRunId: 9,
    currentMeasures: false,
    runs: [
      run(9, job("completed", "skipped"), false),
      run(8, null),
      run(5, job("completed", "success")),
    ],
  };
  assert.deepEqual(assess(state), { action: "wait", runId: 8 });
});

test("each verdict maps to a commit status", () => {
  assert.deepEqual(
    toStatus({ action: "pass", message: "No benchmark requested." }),
    {
      state: "success",
      description: "No benchmark requested.",
    }
  );
  assert.equal(toStatus({ action: "wait", runId: 8 }).state, "pending");
  assert.equal(toStatus({ action: "fail", message: "x" }).state, "failure");
  // GitHub caps status descriptions at 140 characters.
  assert.ok(
    toStatus({ action: "fail", message: "y".repeat(300) }).description.length <=
      140
  );
});
