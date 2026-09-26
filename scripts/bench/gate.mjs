/**
 * The `Benchmark gate` commit status, required on main. Set by
 * benchmark-comment.yml (default branch, write token) after every Benchmark
 * status run (PR opened, pushed, labelled or unlabelled) and every Benchmark
 * run. A commit status, unlike a job's check, is replaced by the next one with
 * the same context, so the gate always shows its latest verdict:
 *
 * - the PR has no `benchmark` label (read now, not from the event) -> success
 * - labelled -> look at the newest run benchmarking the commit: success when
 *   its report succeeded, pending while it is running, failure when it failed
 *   or no run of this commit measures
 *
 * Any API error fails the job without setting a status: a required status
 * that is missing blocks merging, so the gate never passes by accident.
 *
 * Environment: GH_TOKEN, REPO, PR, SHA (the PR head commit), TARGET_URL.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * runs: this workflow's runs of the commit, newest first: whether the run
 * measures (its `Measure sections` jobs were not skipped) and its `report` job
 * ({status, conclusion}), null while that job does not exist yet.
 */
export function assess({
  labelled,
  currentRunId = null,
  currentMeasures = false,
  runs,
}) {
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

/** A verdict as a commit status (descriptions are capped at 140 characters). */
export function toStatus(verdict) {
  const description =
    verdict.action === "wait" ?
      `The benchmark of this commit is running (run ${verdict.runId}).`
    : verdict.message;
  return {
    state: { pass: "success", wait: "pending", fail: "failure" }[
      verdict.action
    ],
    description:
      description.length > 140 ? `${description.slice(0, 139)}…` : description,
  };
}

function api(path) {
  const child = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (child.status !== 0) throw new Error(`gh api ${path}:\n${child.stderr}`);
  return JSON.parse(child.stdout);
}

export function state({ REPO, PR, SHA }) {
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
  return { labelled, runs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { REPO, SHA, TARGET_URL } = process.env;
  const { state: status, description } = toStatus(assess(state(process.env)));
  const child = spawnSync(
    "gh",
    [
      "api",
      `repos/${REPO}/statuses/${SHA}`,
      "-f",
      `state=${status}`,
      "-f",
      "context=Benchmark gate",
      "-f",
      `description=${description}`,
      ...(TARGET_URL ? ["-f", `target_url=${TARGET_URL}`] : []),
    ],
    { encoding: "utf8" }
  );
  if (child.status !== 0) {
    throw new Error(`Setting the status failed:\n${child.stderr}`);
  }
  console.log(
    `Benchmark gate on ${SHA.slice(0, 7)}: ${status} (${description})`
  );
}
