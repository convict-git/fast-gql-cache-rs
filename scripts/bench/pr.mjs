/**
 * Benchmarks this checkout (head) against a base ref, the same way locally and
 * in CI: builds head in place, builds the base in a temporary git worktree with
 * its own pinned toolchain and lockfile, then runs `run.mjs` over both.
 *
 *   npm run bench:pr -- --base main                        # full precision, all sections
 *   npm run bench:pr -- --base main --quick --sections=1   # a quick look
 *
 * Options: --base REF (required), --sections=1,2, --runs=N (default 5), --quick,
 * --out result.json (raw samples; default: a temp file), --no-build (head is
 * already built). Prints the report unless --out is given. If the base cannot
 * be built, head is still measured and the report says why.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const [a] = args.splice(i, 1);
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args.splice(i, 1)[0];
};
const base = opt("--base");
const out = opt("--out");
const noBuild = args.includes("--no-build");
if (noBuild) args.splice(args.indexOf("--no-build"), 1);
if (!base) {
  console.error("Missing --base <ref>");
  process.exit(2);
}

/** Runs a step with its output on stderr, keeping stdout for the report. */
function run(cmd, cmdArgs, cwd, stdout = 2) {
  process.stderr.write(`$ ${[cmd, ...cmdArgs].join(" ")}   (in ${cwd})\n`);
  return spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: ["ignore", stdout, 2],
    // npm is a .cmd shim on Windows, which Node only spawns through a shell.
    shell: cmd === "npm" && process.platform === "win32",
  });
}
const npm = "npm";
const build = (cwd) =>
  [
    [npm, ["run", "wasm:build"]],
    [npm, ["run", "build:ts"]],
  ].find(([cmd, a]) => run(cmd, a, cwd).status !== 0);

if (!noBuild && build(REPO)) {
  console.error("Building head failed.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "fast-gql-bench-"));
const baseDir = join(work, "base");
let baseNote;
const sha = spawnSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
  cwd: REPO,
  encoding: "utf8",
});
if (sha.status !== 0) {
  baseNote = `\`${base}\` is not a commit in this clone`;
} else {
  const baseSha = sha.stdout.trim();
  const steps = [
    ["git", ["worktree", "add", "--detach", baseDir, baseSha], REPO],
    [
      "git",
      ["submodule", "update", "--init", "--depth", "1", "apollo-client-sm"],
      baseDir,
    ],
    [npm, ["ci"], baseDir],
  ];
  const failed =
    steps.find(([cmd, a, cwd]) => run(cmd, a, cwd).status !== 0) ??
    build(baseDir);
  if (failed) {
    baseNote = `building the base \`${baseSha.slice(0, 7)}\` failed at \`${[failed[0], ...failed[1]].join(" ")}\``;
  }
}

const result = out ?? join(work, "result.json");
const measured = run(
  process.execPath,
  [
    fileURLToPath(new URL("run.mjs", import.meta.url)),
    "--out",
    result,
    ...(baseNote ? [] : ["--base-root", baseDir]),
    ...(baseNote ? ["--base-note", baseNote] : []),
    ...args,
  ],
  REPO
);

if (measured.status === 0 && !out) {
  run(
    process.execPath,
    [fileURLToPath(new URL("report.mjs", import.meta.url)), result],
    REPO,
    "inherit"
  );
}
spawnSync("git", ["worktree", "remove", "--force", baseDir], { cwd: REPO });
rmSync(work, { recursive: true, force: true });
process.exit(measured.status ?? 1);
