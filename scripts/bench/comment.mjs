/**
 * Keeps one benchmark comment per PR up to date. Run by
 * `.github/workflows/benchmark-comment.yml`, which holds the write token, so the
 * workflows that run PR code never do.
 *
 *   node scripts/bench/comment.mjs DIR
 *
 * DIR holds `comment-meta.json` ({kind: "status"|"results", pr, headSha}) and,
 * for results, `comment.md` from report.mjs. Environment: GH_TOKEN, REPO
 * (owner/name), RUN_EVENT and RUN_HEAD_SHA (the triggering run's event and
 * commit, used to check that the PR number in the artifact is genuine).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MARKER } from "./report.mjs";

const RESULTS = "<!-- benchmark-results -->";
const short = (sha) => `\`${sha.slice(0, 7)}\``;

/** The comment body after `event`, or null when nothing changes. */
export function nextBody(existing, event) {
  const benchmarked = existing?.match(
    /<!-- benchmarked: ([0-9a-f]{40}) -->/
  )?.[1];
  const results =
    existing?.includes(RESULTS) ?
      existing.slice(existing.indexOf(RESULTS) + RESULTS.length)
    : null;

  if (event.kind === "results") {
    return [
      MARKER,
      `<!-- benchmarked: ${event.headSha} -->`,
      RESULTS,
      event.report.replace(`${MARKER}\n`, ""),
    ].join("\n");
  }

  if (!results) {
    return existing ? null : (
        [
          MARKER,
          "> [!NOTE]",
          "> Not benchmarked yet. Add the `benchmark` label to compare this PR's",
          "> performance against its base (takes about 30–40 minutes).",
          "",
        ].join("\n")
      );
  }
  if (benchmarked === event.headSha) return null;
  return [
    MARKER,
    `<!-- benchmarked: ${benchmarked} -->`,
    "> [!WARNING]",
    `> These results are for ${short(benchmarked)}; the PR is now at ${short(event.headSha)}.`,
    "> Add the `benchmark` label again to refresh them.",
    RESULTS,
    results,
  ].join("\n");
}

function gh(args, input) {
  const child = spawnSync("gh", args, { encoding: "utf8", input });
  if (child.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${child.stderr}`);
  }
  return child.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const { REPO, RUN_EVENT, RUN_HEAD_SHA } = process.env;
  const meta = JSON.parse(readFileSync(join(dir, "comment-meta.json"), "utf8"));
  const pr = Number(meta.pr);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.log("No PR to comment on.");
    process.exit(0);
  }
  // The artifact came from a run of PR code: only trust its PR number if the
  // run's commit belongs to that PR. (Dispatched runs are started by people
  // with write access, who choose the PR themselves.)
  if (RUN_EVENT === "pull_request") {
    const prs = JSON.parse(
      gh([
        "api",
        `repos/${REPO}/commits/${RUN_HEAD_SHA}/pulls`,
        "--jq",
        "[.[].number]",
      ])
    );
    if (!prs.includes(pr)) {
      console.error(
        `Commit ${RUN_HEAD_SHA} is not part of PR #${pr}; not commenting.`
      );
      process.exit(1);
    }
  }

  // One JSON object per line: --paginate cannot combine --slurp with --jq.
  const comments = gh([
    "api",
    "--paginate",
    `repos/${REPO}/issues/${pr}/comments`,
    "--jq",
    `.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("${MARKER}"))) | {id, body}`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const existing = comments[0];
  const body = nextBody(existing?.body ?? null, {
    ...meta,
    report:
      existsSync(join(dir, "comment.md")) ?
        readFileSync(join(dir, "comment.md"), "utf8")
      : undefined,
  });
  if (body === null) {
    console.log("Comment is up to date.");
  } else if (existing) {
    gh(
      [
        "api",
        "-X",
        "PATCH",
        `repos/${REPO}/issues/comments/${existing.id}`,
        "-F",
        "body=@-",
      ],
      body
    );
    console.log(`Updated the benchmark comment on #${pr}.`);
  } else {
    gh(["api", `repos/${REPO}/issues/${pr}/comments`, "-F", "body=@-"], body);
    console.log(`Posted the benchmark comment on #${pr}.`);
  }

  // The label is the trigger: remove it so adding it again re-runs.
  if (meta.kind === "results") {
    spawnSync("gh", [
      "api",
      "-X",
      "DELETE",
      `repos/${REPO}/issues/${pr}/labels/benchmark`,
    ]);
  }
}
