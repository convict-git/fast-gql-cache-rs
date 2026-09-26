/**
 * Runs the performance probe against Apollo's `InMemoryCache` and
 * `InMemoryCacheRs`, for a head checkout and optionally a base checkout, and
 * records every per-run median.
 *
 *   node scripts/bench/run.mjs --out result.json [--base-root DIR] [--head-root DIR]
 *        [--sections=1,2] [--runs=7] [--quick] [--base-note TEXT]
 *
 * Each side runs the probe inside its own checkout, against that checkout's
 * build and `node_modules`: a process never mixes two copies of Apollo Client
 * or graphql (the probe's queries and `cacheSizes` settings would otherwise
 * reach only one of them). Both sides run the same probe: the base checkout
 * must hold head's probe files (pr.mjs copies them), which is checked here.
 * Apollo's cache is measured once per side as the noise control: it is the
 * same code on both sides, so any difference between them is noise.
 *
 * Every section runs in its own fresh process, `--runs` times, and the
 * configurations are interleaved within each run (rotating their order), so
 * drift over the job's lifetime hits base and head alike.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** The probe and the module it loads the cache through: identical on both sides. */
const PROBE_FILES = [
  "docs/probes/cache-performance-probe.mjs",
  "docs/probes/select-cache.mjs",
];
const probeOf = (root) => join(root, PROBE_FILES[0]);

const arg = (name) => {
  const i = process.argv.findIndex(
    (a) => a === name || a.startsWith(`${name}=`)
  );
  if (i === -1) return undefined;
  const a = process.argv[i];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : process.argv[i + 1];
};

const out = arg("--out");
if (!out) {
  console.error("Missing --out <file>");
  process.exit(2);
}
const headRoot = resolve(arg("--head-root") ?? REPO);
const baseRoot = arg("--base-root") && resolve(arg("--base-root"));
const runs = Number(arg("--runs") ?? 7);
const quick = process.argv.includes("--quick");
const sectionCount = Number(
  /const SECTION_COUNT = (\d+);/.exec(
    readFileSync(probeOf(headRoot), "utf8")
  )?.[1]
);
const sections =
  arg("--sections") ?
    arg("--sections").split(",").map(Number)
  : Array.from({ length: sectionCount }, (_, i) => i + 1);

function describe(root) {
  const wasm = resolve(root, "pkg/fast_gql_cache_rs_bg.wasm");
  if (!existsSync(wasm) || !existsSync(resolve(root, "dist/index.js"))) {
    console.error(
      `${root} is not built: run \`npm run wasm:build && npm run build:ts\` there.`
    );
    process.exit(2);
  }
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    root,
    sha: git.status === 0 ? git.stdout.trim() : null,
    wasmBytes: statSync(wasm).size,
  };
}

const sides = {
  head: describe(headRoot),
  ...(baseRoot && { base: describe(baseRoot) }),
};
if (sides.base) {
  for (const file of PROBE_FILES) {
    const theirs = join(baseRoot, file);
    if (
      !existsSync(theirs) ||
      readFileSync(theirs, "utf8") !==
        readFileSync(join(headRoot, file), "utf8")
    ) {
      console.error(
        `${theirs} differs from head's: both sides must run the same probe ` +
          "(scripts/bench/pr.mjs copies head's probe into the base checkout)."
      );
      process.exit(2);
    }
  }
}
const configs = Object.keys(sides).flatMap((side) =>
  ["apollo", "rs"].map((cache) => ({ side, cache, key: `${cache}@${side}` }))
);

const withoutRsRoot = { ...process.env };
delete withoutRsRoot.FAST_GQL_CACHE_RS_ROOT;

/** label -> config key -> per-run medians (ns) */
const samples = {};
// The probe writes its results to a file (--json-out): stdout also carries
// whatever the cache under test prints, and a base build may be noisy.
const resultDir = mkdtempSync(join(tmpdir(), "bench-run-"));

for (let r = 0; r < runs; r++) {
  for (const section of sections) {
    const shift = (r + section) % configs.length;
    const order = [...configs.slice(shift), ...configs.slice(0, shift)];
    for (const { side, cache, key } of order) {
      process.stderr.write(
        `  run ${r + 1}/${runs}, section ${section}, ${key}\n`
      );
      const childJson = join(resultDir, `${r}-${section}-${key}.json`);
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          probeOf(sides[side].root),
          `--json-out=${childJson}`,
          `--sections=${section}`,
          `--cache=${cache}`,
          ...(quick ? ["--quick"] : []),
        ],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          // The probe loads InMemoryCacheRs from its own checkout.
          env: withoutRsRoot,
        }
      );
      if (child.status !== 0) {
        console.error(
          `Section ${section} failed for ${key} (exit ${child.status}):\n${child.stderr}`
        );
        process.exit(1);
      }
      for (const { label, ns } of JSON.parse(readFileSync(childJson, "utf8"))
        .results) {
        ((samples[label] ??= {})[key] ??= []).push(ns);
      }
    }
  }
}

rmSync(resultDir, { recursive: true, force: true });

const meta = {
  schema: 1,
  date: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  runs,
  quick,
  sections,
  head: sides.head,
  base: sides.base ?? null,
  // Why there is no base, for the report (e.g. the base failed to build).
  baseNote: arg("--base-note") ?? null,
};
writeFileSync(out, `${JSON.stringify({ meta, samples }, null, 2)}\n`);
process.stderr.write(
  `wrote ${out}: ${Object.keys(samples).length} measurements\n`
);
