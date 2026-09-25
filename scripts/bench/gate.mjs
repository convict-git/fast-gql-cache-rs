/**
 * The `Benchmark gate` check (benchmark.yml), required on main. Every Benchmark
 * run evaluates it once at the start, and a run that measures evaluates it
 * again at the end; the newest check of that name is the one that counts.
 *
 * - the PR has no `benchmark` label (read now, not from the event) -> pass
 * - labelled -> look at the run that benchmarks the PR's current commit (this
 *   run, or one in flight when this run does not measure): pass when its
 *   report succeeded; fail while it is running (its final check will pass)
 *   and when it failed or no run of this commit measures
 *
 * It never waits: a job holding a runner for the length of a benchmark was
 * cancelled from outside after 47 minutes, leaving the PR blocked. Any API
 * error fails the check: the gate never passes by accident.
 *
 * Environment: GH_TOKEN, REPO, PR, SHA (the PR head), RUN_ID (this run),
 * MEASURES ("true" when this run benchmarks the commit).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * runs: this workflow's runs of the commit, newest first: whether the run
 * measures (its `Measure sections` jobs were not skipped) and its `report` job
 * ({status, conclusion}), null while that job does not exist yet.
 */
export function assess({ labelled, currentRunId, currentMeasures, runs }) {
  if (!labelled) return { action: "pass", message: "No benchmark requested." };
  const follow =
    currentMeasures ?
      runs.find((r) => r.id === currentRunId)
    : runs.find(
        (r) =>
          r.id !== currentRunId &&
          r.measured &&
          !(
            r.report &&
            r.report.status === "completed" &&
            r.report.conclusion !== "success"
          )
      );
  if (!follow) {
    return {
      action: "fail",
      message:
        "No benchmark of this commit is running or has succeeded. Push, or remove " +
        "and re-add the `benchmark` label, to run one; remove it to opt out.",
    };
  }
  const { report } = follow;
  if (!report || report.status !== "completed") {
    return { action: "wait", runId: follow.id };
  }
  return report.conclusion === "success" ?
      { action: "pass", message: `Benchmarked in run ${follow.id}.` }
    : {
        action: "fail",
        message: `The benchmark in run ${follow.id} ended ${report.conclusion}.`,
      };
}

function api(path) {
  const child = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (child.status !== 0) throw new Error(`gh api ${path}:\n${child.stderr}`);
  return JSON.parse(child.stdout);
}

export function state({ REPO, PR, SHA, RUN_ID, MEASURES }) {
  const labelled = api(`repos/${REPO}/issues/${PR}/labels?per_page=100`).some(
    (l) => l.name === "benchmark"
  );
  const runs =
    labelled ?
      api(
        `repos/${REPO}/actions/workflows/benchmark.yml/runs?head_sha=${SHA}&per_page=100`
      ).workflow_runs.map(({ id }) => {
        const { jobs } = api(
          `repos/${REPO}/actions/runs/${id}/jobs?per_page=100`
        );
        return {
          id,
          measured: jobs.some(
            (j) =>
              j.name.startsWith("Measure sections") &&
              j.conclusion !== "skipped"
          ),
          report: jobs.find((j) => j.name === "report") ?? null,
        };
      })
    : [];
  return {
    labelled,
    currentRunId: Number(RUN_ID),
    currentMeasures: MEASURES === "true",
    runs,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const verdict = assess(state(process.env));
  if (verdict.action === "pass") {
    console.log(verdict.message);
  } else {
    console.log(
      `::error::${
        verdict.action === "wait" ?
          `The benchmark of this commit is running (run ${verdict.runId}); this check passes when it finishes.`
        : verdict.message
      }`
    );
    process.exit(1);
  }
}
