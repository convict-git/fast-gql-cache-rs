/**
 * Executable performance probe for Apollo Client's `InMemoryCache` (v4.2.11).
 *
 * Companion to the performance guide (`docs/performance/`): every measured cost
 * claim in that guide is produced by this file. Re-run it to re-derive the
 * numbers on a new machine or a new Apollo version.
 *
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --runs=5
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --quick
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --json > results.json
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --sections=1,13
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --runs=5 --save=agg.json
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --load=agg.json
 *
 * `--save` writes the aggregated per-run medians of a `--runs` measurement to a
 * JSON file; `--load` re-renders the report from such a file without measuring
 * (the deterministic observations are recomputed).
 *
 * Deliberately NOT run with `--conditions=development`: the development build
 * deep-freezes every read result (`maybeDeepFreeze`) and runs
 * `warnAboutDataLoss` on every write, neither of which ships to production. The
 * last measured section quantifies that overhead by re-invoking this file in
 * two fresh child processes, one with the development condition and one
 * without, so both builds are measured from the same (fresh) process state.
 *
 * Method
 * ------
 * Each measurement runs `setup` (untimed) then `run` (timed), first `warmup`
 * times untimed and then `reps` times timed, and keeps the MEDIAN of the timed
 * repetitions, which is far more robust than the mean against GC pauses and JIT
 * tiering. One full garbage collection runs between the warm-ups and the timed
 * repetitions. (Not one per repetition: a forced full GC right before a
 * microsecond operation makes it one to two orders of magnitude slower, which
 * would measure the GC's side effects instead of the cache.)
 *
 * With `--runs=R`, every section is measured in its OWN fresh Node process,
 * and that is repeated R times; every reported timing is the MEDIAN ACROSS THE
 * R RUNS of the per-run medians. Fresh processes matter twice over. Within one
 * long process, the same operation gets measurably slower in later sections
 * (JIT feedback and heap state accumulated by earlier sections), so sections
 * would not be comparable. And across processes, JIT state, heap layout and GC
 * timing differ, so a single process can be unlucky as a whole. The summary
 * reports the run-to-run spread of every measurement, so a reader can see how
 * much a number moves between runs. Deterministic observations (memo sizes,
 * counts, identities) do not vary and are computed once, in the reporting
 * process.
 *
 * Scaling columns divide adjacent (aggregated) values so the growth rate is
 * visible without a curve fit.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InMemoryCache } from "@apollo/client/cache";
import { cacheSizes } from "@apollo/client/utilities";
import { gql } from "graphql-tag";

const QUICK = process.argv.includes("--quick");
const JSON_OUT = process.argv.includes("--json");
const IS_CHILD = process.argv.includes("--child-build");
/** `--sections=1,13` runs only those sections (for investigating one area). */
const SECTIONS = (() => {
  const arg = process.argv.find((a) => a.startsWith("--sections="));
  return arg ?
      new Set(arg.slice("--sections=".length).split(",").map(Number))
    : null;
})();
const RUNS_ARG = process.argv.find((a) => a.startsWith("--runs="));
const argValue = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};
const SAVE_PATH = argValue("save");
const LOAD_PATH = argValue("load");
const RUNS = Math.max(1, Number((RUNS_ARG || "--runs=1").slice(7)) || 1);
/** Number of measured sections (the summary that follows is not one). */
const SECTION_COUNT = 14;
const REPS = QUICK ? 7 : 25;
const WARMUP = 3;
const results = [];
const seenLabels = new Set();

/**
 * Aggregated timings, keyed by label, when this process only REPORTS the
 * medians of `RUNS` independent measuring processes (see `aggregateRuns`).
 * While it is set, `bench` looks timings up instead of measuring them.
 */
let AGGREGATE = null;
/** Whether the development-build child reported frozen results. */
let devFrozen;

const PROBE_QUERY = gql`
  query DevBuildProbe {
    a {
      __typename
      id
    }
  }
`;

/** True when Node resolved the development build (results are deep-frozen). */
function isDevBuild() {
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: PROBE_QUERY,
    data: { a: { __typename: "A", id: "1" } },
  });
  return Object.isFrozen(cache.readQuery({ query: PROBE_QUERY }));
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

const now = () => Number(process.hrtime.bigint());

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Timed measurement. `setup` is re-run before every rep and is never timed. */
function bench(label, { setup, run, reps = REPS, warmup = WARMUP }) {
  if (seenLabels.has(label)) {
    throw new Error(`Duplicate measurement label: ${label}`);
  }
  seenLabels.add(label);
  if (AGGREGATE) {
    const agg = AGGREGATE.get(label);
    if (!agg) throw new Error(`No aggregated value for: ${label}`);
    return agg.median;
  }
  for (let i = 0; i < warmup; i++) {
    const state = setup ? setup() : undefined;
    run(state);
  }
  globalThis.gc?.();

  const samples = [];
  for (let i = 0; i < reps; i++) {
    const state = setup ? setup() : undefined;
    const t0 = now();
    run(state);
    samples.push(now() - t0);
  }
  const ns = median(samples);
  results.push({ label, ns });
  return ns;
}

/** Signed percentage change of `value` relative to `base`, e.g. "-12%". */
function pctChange(value, base) {
  const pct = (value / base - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function fmt(ns) {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)} us`;
  return `${ns.toFixed(0)} ns`;
}

/**
 * Prints a section header and returns whether the section should run. The
 * development-build child process only needs the one section that measures it,
 * so every other section is skipped there.
 */
let sectionNo = 0;
function section(title) {
  ++sectionNo;
  if (IS_CHILD) return false;
  if (SECTIONS && !SECTIONS.has(sectionNo)) return false;
  if (!JSON_OUT) {
    console.log(
      `\n${"=".repeat(86)}\n${sectionNo}. ${title}\n${"=".repeat(86)}`
    );
  }
  return true;
}

function note(text) {
  if (!JSON_OUT) console.log(`\n${text}`);
}

/**
 * Prints a scaling table. `rows` is [[sizeLabel, size, {col: ns}], ...], and
 * `sizeName` names the variable in the first column (the symbol the
 * performance guide uses for it, e.g. "N" for list length).
 * Adds a "scale" column per measurement: the growth against the previous row
 * divided by the size ratio (1.00 = linear; a constant cost reads as
 * 1/ratio; a quadratic step reads as the size ratio itself, e.g. 4.00 for a
 * 4x step).
 */
function table(title, columns, rows, sizeName) {
  if (JSON_OUT) return;
  console.log(`\n  ${title}`);
  const head = [sizeName.padStart(8)];
  for (const c of columns) head.push(c.padStart(13), "scale".padStart(8));
  console.log(`  ${head.join(" ")}`);
  console.log(`  ${"-".repeat(head.join(" ").length)}`);

  let prev = null;
  let prevSize = null;
  for (const [sizeLabel, size, values] of rows) {
    const cells = [String(sizeLabel).padStart(8)];
    for (const c of columns) {
      cells.push(fmt(values[c]).padStart(13));
      if (prev && prevSize) {
        const growth = values[c] / prev[c];
        const sizeRatio = size / prevSize;
        cells.push(`${(growth / sizeRatio).toFixed(2)}`.padStart(8));
      } else {
        cells.push("-".padStart(8));
      }
    }
    console.log(`  ${cells.join(" ")}`);
    prev = values;
    prevSize = size;
  }
  console.log(
    `  (scale = growth factor / size ratio of adjacent rows: 1.00 = linear, 1/ratio = constant, ratio = quadratic)`
  );
}

/** Counts `execSelectionSetImpl` / `execSubSelectedArrayImpl` calls (memo misses). */
function countRecomputes(cache) {
  const reader = cache["storeReader"];
  const counts = { selectionSets: 0, arrays: 0 };
  const sel = reader["execSelectionSetImpl"].bind(reader);
  const arr = reader["execSubSelectedArrayImpl"].bind(reader);
  reader["execSelectionSetImpl"] = (options) => {
    counts.selectionSets++;
    return sel(options);
  };
  reader["execSubSelectedArrayImpl"] = (options) => {
    counts.arrays++;
    return arr(options);
  };
  counts.reset = () => {
    counts.selectionSets = 0;
    counts.arrays = 0;
  };
  return counts;
}

/** Runs `fn` with a temporary `cacheSizes` override, restoring it afterwards. */
function withCacheSize(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(cacheSizes, key);
  const saved = cacheSizes[key];
  cacheSizes[key] = value;
  try {
    return fn();
  } finally {
    if (had) cacheSizes[key] = saved;
    else delete cacheSizes[key];
  }
}

// ---------------------------------------------------------------------------
// Multi-run aggregation
// ---------------------------------------------------------------------------

/**
 * Measures every selected section `RUNS` times, each time in a fresh child
 * process that runs only that section (a plain `--json --sections=k` run), and
 * returns, per label, the median, minimum and maximum of the per-run medians.
 */
function aggregateRuns() {
  const perLabel = new Map();
  let devFrozen;
  const sections =
    SECTIONS ?
      [...SECTIONS].sort((a, b) => a - b)
    : Array.from({ length: SECTION_COUNT }, (_, i) => i + 1);
  for (let r = 0; r < RUNS; r++) {
    for (const k of sections) {
      if (!JSON_OUT) {
        process.stderr.write(
          `  measuring: run ${r + 1} of ${RUNS}, section ${k}...\n`
        );
      }
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          fileURLToPath(import.meta.url),
          "--json",
          `--sections=${k}`,
          ...(QUICK ? ["--quick"] : []),
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 }
      );
      if (child.status !== 0) {
        throw new Error(
          `Measuring run ${r + 1}, section ${k} failed (exit ${child.status}):\n${child.stderr}`
        );
      }
      const parsed = JSON.parse(child.stdout);
      if (parsed.devFrozen !== undefined) devFrozen = parsed.devFrozen;
      for (const { label, ns } of parsed.results) {
        if (!perLabel.has(label)) perLabel.set(label, []);
        perLabel.get(label).push(ns);
      }
    }
  }
  const aggregate = new Map();
  for (const [label, values] of perLabel) {
    aggregate.set(label, {
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      runs: values,
    });
  }
  aggregate.devFrozen = devFrozen;
  aggregate.runCount = RUNS;
  return aggregate;
}

/** Serializes an aggregate (see `aggregateRuns`) for `--save`. */
function aggregateToJson(aggregate) {
  return {
    meta: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      quick: QUICK,
      repsPerMeasurement: REPS,
      warmupsPerMeasurement: WARMUP,
      runs: aggregate.runCount,
    },
    devFrozen: aggregate.devFrozen,
    results: [...aggregate].map(([label, a]) => ({ label, ...a })),
  };
}

if (LOAD_PATH && !IS_CHILD) {
  const saved = JSON.parse(readFileSync(LOAD_PATH, "utf8"));
  if (saved.meta.quick !== QUICK) {
    throw new Error(
      `${LOAD_PATH} was measured ${saved.meta.quick ? "with" : "without"} --quick; pass the same flag to render it`
    );
  }
  AGGREGATE = new Map(saved.results.map(({ label, ...a }) => [label, a]));
  AGGREGATE.devFrozen = saved.devFrozen;
  AGGREGATE.runCount = saved.meta.runs;
  AGGREGATE.meta = saved.meta;
} else if (RUNS_ARG && !IS_CHILD) {
  AGGREGATE = aggregateRuns();
  if (SAVE_PATH) {
    writeFileSync(
      SAVE_PATH,
      `${JSON.stringify(aggregateToJson(AGGREGATE), null, 2)}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Shape generators
// ---------------------------------------------------------------------------

/** A flat list of normalizable entities, each with `fields` scalar fields. */
function wideNormalized(count, fields = 6) {
  const scalarFields = Array.from({ length: fields }, (_, i) => `f${i}`);
  const query = gql`
    query Wide {
      feed {
        __typename
        id
        ${scalarFields.join("\n        ")}
      }
    }
  `;
  const data = {
    feed: Array.from({ length: count }, (_, i) => {
      const item = { __typename: "Item", id: `i${i}` };
      for (const f of scalarFields) item[f] = `${f}-value-${i}`;
      return item;
    }),
  };
  return { query, data, scalarFields };
}

/** The same list, but the items carry no `id`, so they stay embedded. */
function wideUntyped(count, fields = 6) {
  const scalarFields = Array.from({ length: fields }, (_, i) => `f${i}`);
  const query = gql`
    query WideUntyped {
      feed {
        __typename
        ${scalarFields.join("\n        ")}
      }
    }
  `;
  const data = {
    feed: Array.from({ length: count }, (_, i) => {
      const item = { __typename: "Embedded" };
      for (const f of scalarFields) item[f] = `${f}-value-${i}`;
      return item;
    }),
  };
  return { query, data };
}

/**
 * A single chain of `depth` normalizable entities: root -> child -> child ...
 * (Node:n0 is ROOT_QUERY.root, Node:n<depth-1> is the leaf.)
 */
function deepNormalized(depth, fields = 3) {
  const scalarFields = Array.from({ length: fields }, (_, i) => `f${i}`);
  let selection = `__typename\n        id\n        ${scalarFields.join("\n        ")}`;
  for (let d = 1; d < depth; d++) {
    selection = `__typename\n        id\n        ${scalarFields.join("\n        ")}\n        child {\n        ${selection}\n        }`;
  }
  const query = gql`
    query Deep {
      root {
        ${selection}
      }
    }
  `;
  const build = (d) => {
    const node = { __typename: "Node", id: `n${d}` };
    for (const f of scalarFields) node[f] = `${f}-${d}`;
    if (d < depth - 1) node.child = build(d + 1);
    return node;
  };
  return { query, data: { root: build(0) } };
}

/** The same chain, but with no `id` fields, so the whole tree stays embedded. */
function deepUntyped(depth, fields = 3) {
  const scalarFields = Array.from({ length: fields }, (_, i) => `f${i}`);
  let selection = `__typename\n        ${scalarFields.join("\n        ")}`;
  for (let d = 1; d < depth; d++) {
    selection = `__typename\n        ${scalarFields.join("\n        ")}\n        child {\n        ${selection}\n        }`;
  }
  const query = gql`
    query DeepUntyped {
      root {
        ${selection}
      }
    }
  `;
  const build = (d) => {
    const node = { __typename: "Blob" };
    for (const f of scalarFields) node[f] = `${f}-${d}`;
    if (d < depth - 1) node.child = build(d + 1);
    return node;
  };
  return { query, data: { root: build(0) } };
}

/** `outer` lists each containing `inner` normalizable entities. */
function nestedArrays(outer, inner) {
  const query = gql`
    query Matrix {
      groups {
        __typename
        id
        rows {
          __typename
          id
          value
        }
      }
    }
  `;
  const data = {
    groups: Array.from({ length: outer }, (_, g) => ({
      __typename: "Group",
      id: `g${g}`,
      rows: Array.from({ length: inner }, (_, r) => ({
        __typename: "Row",
        id: `g${g}r${r}`,
        value: `v${g}-${r}`,
      })),
    })),
  };
  return { query, data };
}

/** Arrays of arrays of plain scalars — no entities, pure `processFieldValue` recursion. */
function scalarMatrix(outer, inner) {
  const query = gql`
    query ScalarMatrix {
      matrix
    }
  `;
  const data = {
    matrix: Array.from({ length: outer }, (_, g) =>
      Array.from({ length: inner }, (_, r) => `${g}:${r}`)
    ),
  };
  return { query, data };
}

function freshCache(config) {
  return new InMemoryCache(config);
}

function written(shape, config) {
  const cache = freshCache(config);
  cache.writeQuery({ query: shape.query, data: shape.data });
  return cache;
}

/** Number of live memo entries in StoreReader's two caches. */
function memoSizes(cache) {
  const reader = cache["storeReader"];
  return {
    selectionSets: reader["executeSelectionSet"].size,
    arrays: reader["executeSubSelectedArray"].size,
  };
}

// ===========================================================================
if (section("Write cost vs. list breadth (normalized entities)")) {
  const sizes = QUICK ? [100, 1000] : [100, 1000, 5000, 20000];
  const rows = [];
  for (const n of sizes) {
    const shape = wideNormalized(n);
    const cold = bench(`write cold N=${n}`, {
      setup: () => freshCache(),
      run: (cache) => cache.writeQuery({ query: shape.query, data: shape.data }),
    });
    const identical = bench(`write identical N=${n}`, {
      setup: () => written(shape),
      run: (cache) => cache.writeQuery({ query: shape.query, data: shape.data }),
    });
    const oneChanged = (() => {
      const changed = {
        feed: shape.data.feed.map((item, i) =>
          i === 0 ? { ...item, f0: "CHANGED" } : item
        ),
      };
      return bench(`write 1-changed N=${n}`, {
        setup: () => written(shape),
        run: (cache) => cache.writeQuery({ query: shape.query, data: changed }),
      });
    })();
    rows.push([n, n, { cold, identical, "1 changed": oneChanged }]);
  }
  table(
    "writeQuery into a list of N normalized entities (F = 8 fields each)",
    ["cold", "identical", "1 changed"],
    rows,
    "N"
  );
  note(
    `  Reading: "identical" still pays the full traversal + normalization + deep\n` +
      `  equality; it only avoids dirtying fields. There is no early-out for an\n` +
      `  unchanged payload, because the writer cannot know it is unchanged until it\n` +
      `  has normalized it.`
  );

  // The "cold" column is inflated at small n by one-time per-cache setup, not by
  // per-entity work. Isolate it by writing into a cache that is empty but has
  // already transformed this document and materialized its policies.
  {
    const shape = wideNormalized(100);
    const primed = () => {
      const c = freshCache();
      c.writeQuery({ query: shape.query, data: { feed: [] } });
      c.evict({ id: "ROOT_QUERY", fieldName: "feed" });
      return c;
    };
    const coldFresh = bench("write 100 into a brand-new cache", {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const coldPrimed = bench("write 100 into a primed EMPTY cache", {
      setup: primed,
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const overwrite = bench("overwrite 100 existing entities", {
      setup: () => written(shape),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const cheaper =
      overwrite <= coldPrimed ?
        `overwriting is ${((1 - overwrite / coldPrimed) * 100).toFixed(0)}% cheaper here`
      : `creating is ${((1 - coldPrimed / overwrite) * 100).toFixed(0)}% cheaper here`;
    const firstScale =
      rows.length > 1 ?
        rows[1][2].cold / rows[0][2].cold / (rows[1][1] / rows[0][1])
      : NaN;
    note(
      `  The N=100 "cold" cell carries costs that are not per-entity work (the next\n` +
        `  row's scale is ${firstScale.toFixed(2)}). Re-measuring the same kind of write later in the\n` +
        `  same process:\n` +
        `    write cold N=100, as measured first : ${fmt(rows[0][2].cold)}\n` +
        `    brand-new cache, 100 new entities   : ${fmt(coldFresh)} (${pctChange(coldFresh, rows[0][2].cold)} vs. first)\n` +
        `    primed EMPTY cache, 100 new         : ${fmt(coldPrimed)} (${pctChange(coldPrimed, coldFresh)} vs. brand-new)\n` +
        `    overwrite of 100 existing           : ${fmt(overwrite)}\n` +
        `  Two separate effects:\n` +
        `    1. JIT. The table's cold N=100 is the FIRST measurement in the process;\n` +
        `       the difference to "brand-new" is what warming up the process buys.\n` +
        `    2. One-time per-cache setup (document transform, type policies, fresh\n` +
        `       StoreReader/StoreWriter): the gap between "brand-new" and "primed".\n` +
        `  With both removed, CREATING n entities and OVERWRITING n identical ones cost\n` +
        `  about the same (${cheaper}): a creation dirties every\n` +
        `  field, an overwrite compares every incoming field with the stored one instead.`
    );
  }

  // The duplicate guard (context.written) runs only AFTER an object's fields
  // have been processed, so a repeated occurrence of the same entity is still
  // traversed and identified; only its staging into the store is skipped.
  {
    let identifyCalls = 0;
    const cache = freshCache({
      dataIdFromObject(object) {
        identifyCalls++;
        return `${object.__typename}:${object.id}`;
      },
    });
    const query = gql`
      query Repeated {
        list {
          __typename
          id
          text
          child {
            __typename
            id
          }
        }
      }
    `;
    const item = {
      __typename: "T",
      id: 1,
      text: "first",
      child: { __typename: "C", id: 9 },
    };
    cache.writeQuery({
      query,
      data: { list: [item, { ...item, text: "second" }, item] },
    });
    note(
      `  The same entity T:1 (with a child C:9) three times in one list:\n` +
        `    identify calls        : ${identifyCalls} (3 x T:1 + 3 x C:9; every occurrence is traversed)\n` +
        `    stored T:1.text       : ${JSON.stringify(cache.extract()["T:1"].text)} (only the first occurrence is staged)`
    );
  }
}

// ===========================================================================
if (section("Read cost vs. list breadth: cold, warm, and after one dirty field")) {
  const sizes = QUICK ? [100, 1000] : [100, 1000, 5000, 20000];
  const rows = [];
  for (const n of sizes) {
    const shape = wideNormalized(n);

    const cold = bench(`read cold N=${n}`, {
      setup: () => {
        const cache = written(shape);
        cache.gc({ resetResultCache: true });
        return cache;
      },
      run: (cache) => cache.readQuery({ query: shape.query }),
    });

    const warmCache = written(shape);
    warmCache.readQuery({ query: shape.query });
    const warm = bench(`read warm N=${n}`, {
      run: () => warmCache.readQuery({ query: shape.query }),
    });

    const afterDirty = bench(`read after 1 dirty N=${n}`, {
      setup: () => {
        const cache = written(shape);
        cache.readQuery({ query: shape.query });
        cache.modify({
          id: "Item:i0",
          fields: { f0: (v) => `${v}!` },
        });
        return cache;
      },
      run: (cache) => cache.readQuery({ query: shape.query }),
    });

    rows.push([n, n, { cold, warm, "after 1 dirty": afterDirty }]);
  }
  table(
    "readQuery over a list of N normalized entities (F = 8 fields each)",
    ["cold", "warm", "after 1 dirty"],
    rows,
    "N"
  );

  // Structure-sharing evidence.
  const shape = wideNormalized(500);
  const cache = written(shape);
  const before = cache.readQuery({ query: shape.query });
  cache.modify({ id: "Item:i0", fields: { f0: (v) => `${v}!` } });
  const after = cache.readQuery({ query: shape.query });
  let shared = 0;
  for (let i = 0; i < before.feed.length; i++) {
    if (before.feed[i] === after.feed[i]) shared++;
  }
  const ratios = rows.map(([, , v]) => v.cold / v["after 1 dirty"]);
  const recomputed = (() => {
    const c = written(shape);
    const counts = countRecomputes(c);
    c.readQuery({ query: shape.query });
    c.modify({ id: "Item:i0", fields: { f0: (v) => `${v}!` } });
    counts.reset();
    c.readQuery({ query: shape.query });
    return counts;
  })();
  note(
    `  Note that "after 1 dirty" is still LINEAR in N, ${Math.min(...ratios).toFixed(1)}-${Math.max(...ratios).toFixed(1)}x cheaper than a\n` +
      `  cold read. Only three memo entries re-execute (N=500: ${recomputed.selectionSets} executeSelectionSet +\n` +
      `  ${recomputed.arrays} executeSubSelectedArray: the entity, the root, the array), but re-executing\n` +
      `  the array entry means N canRead calls plus N memoized executeSelectionSet\n` +
      `  lookups. Entries-recomputed and work-done are not the same.`
  );
  note(
    `  Structure sharing after modifying 1 of 500 entities:\n` +
      `    identical (===) array elements reused: ${shared}/500\n` +
      `    top-level result object reused:        ${before === after}\n` +
      `    feed array reused:                     ${before.feed === after.feed}\n` +
      `  The parent array is rebuilt (it is one memo entry) but every untouched\n` +
      `  element object is reused by reference. That is what keeps React re-renders\n` +
      `  proportional to what actually changed.`
  );

  const sizesForMemo = QUICK ? [100, 1000] : [100, 1000, 5000];
  const memoRows = sizesForMemo.map((n) => {
    const s = wideNormalized(n);
    const c = written(s);
    c.readQuery({ query: s.query });
    const m = memoSizes(c);
    return `    N=${String(n).padStart(5)}  executeSelectionSet=${String(m.selectionSets).padStart(6)}  executeSubSelectedArray=${m.arrays}`;
  });
  note(
    `  Memo entries retained by a single read (bounded by cacheSizes limits\n` +
      `  50 000 / 10 000 respectively):\n${memoRows.join("\n")}`
  );

  // Fan-in: many parents referencing one entity. The shared author entry
  // recomputes once, but every comment entry is its parent and reruns too.
  {
    const query = gql`
      query FanIn {
        comments {
          __typename
          id
          body
          author {
            __typename
            id
            name
          }
        }
      }
    `;
    const c = freshCache();
    const counts = countRecomputes(c);
    c.writeQuery({
      query,
      data: {
        comments: Array.from({ length: 500 }, (_, i) => ({
          __typename: "Comment",
          id: i,
          body: `b${i}`,
          author: { __typename: "User", id: 1, name: "Ann" },
        })),
      },
    });
    c.readQuery({ query });
    counts.reset();
    c.modify({ id: "User:1", fields: { name: () => "Bob" } });
    c.readQuery({ query });
    note(
      `  Fan-in: 500 comments whose author is the same User:1. After changing\n` +
        `  User:1.name, one re-read re-executes ${counts.selectionSets} executeSelectionSet entries (the\n` +
        `  author, all 500 comments, the root) and ${counts.arrays} executeSubSelectedArray entry.`
    );
  }
}

// ===========================================================================
if (section("Normalized vs. embedded (untyped) payloads of the same size")) {
  const sizes = QUICK ? [100, 1000] : [100, 1000, 5000];
  const rows = [];
  for (const n of sizes) {
    const norm = wideNormalized(n);
    const untyped = wideUntyped(n);

    const wNorm = bench(`write normalized N=${n}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: norm.query, data: norm.data }),
    });
    const wUntyped = bench(`write untyped N=${n}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: untyped.query, data: untyped.data }),
    });

    // Rewriting the identical payload over existing data: the normalized form
    // re-traverses and re-stages every entity; the embedded form compares the
    // whole list with equal() in one field.
    const rwNorm = bench(`rewrite identical normalized N=${n}`, {
      setup: () => written(norm),
      run: (c) => c.writeQuery({ query: norm.query, data: norm.data }),
    });
    const rwUntyped = bench(`rewrite identical untyped N=${n}`, {
      setup: () => written(untyped),
      run: (c) => c.writeQuery({ query: untyped.query, data: untyped.data }),
    });

    const normWarm = written(norm);
    normWarm.readQuery({ query: norm.query });
    const rNorm = bench(`read warm normalized N=${n}`, {
      run: () => normWarm.readQuery({ query: norm.query }),
    });

    const untypedWarm = written(untyped);
    untypedWarm.readQuery({ query: untyped.query });
    const rUntyped = bench(`read warm untyped N=${n}`, {
      run: () => untypedWarm.readQuery({ query: untyped.query }),
    });

    rows.push([
      n,
      n,
      {
        "write norm": wNorm,
        "write embed": wUntyped,
        "rewrite norm": rwNorm,
        "rewrite embed": rwUntyped,
        "read norm": rNorm,
        "read embed": rUntyped,
      },
    ]);
  }
  table(
    "N objects with 6 scalar fields each, normalized (+ id) or embedded (no id)",
    [
      "write norm",
      "write embed",
      "rewrite norm",
      "rewrite embed",
      "read norm",
      "read embed",
    ],
    rows,
    "N"
  );

  const n = QUICK ? 200 : 2000;
  const norm = written(wideNormalized(n));
  const untyped = written(wideUntyped(n));
  note(
    `  Store entry counts for N=${n}:\n` +
      `    normalized: ${Object.keys(norm.extract()).length} entries (1 root + N entities)\n` +
      `    embedded:   ${Object.keys(untyped.extract()).length} entries (root only — the whole list lives in one field)`
  );
  note(
    `  Embedded payloads write faster (identify() finds no id, so there is no\n` +
      `  per-entity staging, store.merge or reference) and read equally fast warm,\n` +
      `  but they are a single cache field: changing one element dirties the entire\n` +
      `  list, and nothing is shared with any other query.`
  );
}

// ===========================================================================
if (section("Depth: cost per level of nesting")) {
  const depths = QUICK ? [4, 16] : [4, 16, 64, 256, 512];
  const rows = [];
  for (const d of depths) {
    const norm = deepNormalized(d);
    const untyped = deepUntyped(d);

    const w = bench(`write deep normalized d=${d}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: norm.query, data: norm.data }),
    });
    const wU = bench(`write deep untyped d=${d}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: untyped.query, data: untyped.data }),
    });

    const rc = bench(`read cold deep d=${d}`, {
      setup: () => {
        const c = written(norm);
        c.gc({ resetResultCache: true });
        return c;
      },
      run: (c) => c.readQuery({ query: norm.query }),
    });

    const warm = written(norm);
    warm.readQuery({ query: norm.query });
    const rw = bench(`read warm deep d=${d}`, {
      run: () => warm.readQuery({ query: norm.query }),
    });

    // Dirty the DEEPEST entity: how far does invalidation propagate?
    const deepDirty = bench(`read after deepest dirty d=${d}`, {
      setup: () => {
        const c = written(norm);
        c.readQuery({ query: norm.query });
        c.modify({ id: `Node:n${d - 1}`, fields: { f0: (v) => `${v}!` } });
        return c;
      },
      run: (c) => c.readQuery({ query: norm.query }),
    });

    rows.push([
      d,
      d,
      {
        "write norm": w,
        "write embed": wU,
        "read cold": rc,
        "read warm": rw,
        "deep dirty": deepDirty,
      },
    ]);
  }
  table(
    "a single chain of D nested entities (3 scalar fields each), leaf = entity D",
    ["write norm", "write embed", "read cold", "read warm", "deep dirty"],
    rows,
    "D"
  );
  const counts = depths.map((d) => {
    const norm = deepNormalized(d);
    const c = written(norm);
    const recomputes = countRecomputes(c);
    c.readQuery({ query: norm.query });
    c.modify({ id: `Node:n${d - 1}`, fields: { f0: (v) => `${v}!` } });
    recomputes.reset();
    c.readQuery({ query: norm.query });
    return `D=${d}: ${recomputes.selectionSets}`;
  });
  note(
    `  "deep dirty" is the headline number: modifying the LEAF marks every ancestor\n` +
      `  memo entry as having a dirty child, and the next read re-executes all of them\n` +
      `  (entries re-executed: ${counts.join(", ")}; that is D + 1 with ROOT_QUERY).\n` +
      `  Each ancestor that finishes recomputing reports "clean" to its parent, and in\n` +
      `  optimism 0.18.1 that report climbs all the way to the root, because every\n` +
      `  ancestor above is only dirty-by-child, not dirty itself. Level l therefore\n` +
      `  costs O(l) on top of its own work, and the re-read is O(D^2) in total. A cold\n` +
      `  read does not pay this: new entries are dirty themselves, so the report stops\n` +
      `  at the first parent. Watch the scale column of "deep dirty" climb towards the\n` +
      `  step ratio (quadratic) while "read cold" stays near 1.00 (linear), and the\n` +
      `  re-read overtake the cold read of the whole chain. Breadth does not do this —\n` +
      `  see section 2.`
  );
}

// ===========================================================================
if (section("Nested arrays: outer x inner")) {
  const configs =
    QUICK ?
      [
        [10, 10],
        [10, 100],
      ]
    : [
        [10, 10],
        [10, 100],
        [100, 100],
        [100, 500],
      ];
  const rows = [];
  for (const [outer, inner] of configs) {
    const shape = nestedArrays(outer, inner);
    const w = bench(`write matrix ${outer}x${inner}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const rc = bench(`read cold matrix ${outer}x${inner}`, {
      setup: () => {
        const c = written(shape);
        c.gc({ resetResultCache: true });
        return c;
      },
      run: (c) => c.readQuery({ query: shape.query }),
    });
    const warm = written(shape);
    warm.readQuery({ query: shape.query });
    const rw = bench(`read warm matrix ${outer}x${inner}`, {
      run: () => warm.readQuery({ query: shape.query }),
    });
    const oneRow = bench(`read after 1 row dirty ${outer}x${inner}`, {
      setup: () => {
        const c = written(shape);
        c.readQuery({ query: shape.query });
        c.modify({ id: "Row:g0r0", fields: { value: (v) => `${v}!` } });
        return c;
      },
      run: (c) => c.readQuery({ query: shape.query }),
    });
    rows.push([
      `${outer}x${inner}`,
      outer * inner,
      { write: w, "read cold": rc, "read warm": rw, "1 row dirty": oneRow },
    ]);
  }
  table(
    "G groups each holding R normalized rows (size = G x R rows)",
    ["write", "read cold", "read warm", "1 row dirty"],
    rows,
    "GxR"
  );
  note(
    `  Watch the "read warm" column at 100x500. Every other row is a few us; that\n` +
      `  one jumps by three orders of magnitude. 100*500 rows + 100 groups +\n` +
      `  ROOT_QUERY = 50101 entities, just over the 50 000 executeSelectionSet limit,\n` +
      `  so the LRU trim that runs after every read evicts entries this query needs,\n` +
      `  and the next "warm" read recomputes them. This is the LRU cliff of section 9\n` +
      `  reached by accident, from a shape that looks unremarkable.`
  );

  const scalarConfigs = QUICK ? [[10, 100]] : [
    [10, 100],
    [100, 100],
    [100, 1000],
  ];
  const scalarRows = [];
  for (const [outer, inner] of scalarConfigs) {
    const shape = scalarMatrix(outer, inner);
    const equalCopy = scalarMatrix(outer, inner);
    const w = bench(`write scalar matrix ${outer}x${inner}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const rewrite = bench(`rewrite equal scalar matrix ${outer}x${inner}`, {
      setup: () => written(shape),
      run: (c) => c.writeQuery({ query: shape.query, data: equalCopy.data }),
    });
    const cold = bench(`read cold scalar matrix ${outer}x${inner}`, {
      setup: () => {
        const c = written(shape);
        c.gc({ resetResultCache: true });
        return c;
      },
      run: (c) => c.readQuery({ query: shape.query }),
    });
    const warm = written(shape);
    warm.readQuery({ query: shape.query });
    const rw = bench(`read warm scalar matrix ${outer}x${inner}`, {
      run: () => warm.readQuery({ query: shape.query }),
    });
    scalarRows.push([
      `${outer}x${inner}`,
      outer * inner,
      { write: w, "rewrite equal": rewrite, "read cold": cold, "read warm": rw },
    ]);
  }
  table(
    "arrays of arrays of plain scalars (no entities, no selection set)",
    ["write", "rewrite equal", "read cold", "read warm"],
    scalarRows,
    "GxR"
  );
  const [outer, inner] = scalarConfigs[scalarConfigs.length - 1];
  const shape = scalarMatrix(outer, inner);
  const c = written(shape);
  const readBack = c.readQuery({ query: shape.query });
  const m = memoSizes(c);
  note(
    `  A scalar array without a sub-selection is stored as ONE field value, by\n` +
      `  reference in production (${outer}x${inner}: stored === written: ${c.extract().ROOT_QUERY.matrix === shape.data.matrix}).\n` +
      `  Writing it into an empty field is O(1); rewriting it with an equal copy runs\n` +
      `  equal() over every element. Reading it is NOT a property lookup:\n` +
      `  executeSubSelectedArray maps every nested array into a new one (read result\n` +
      `  === stored: ${readBack.matrix === shape.data.matrix}) and memoizes each array instance separately\n` +
      `  (${m.arrays} executeSubSelectedArray entries for ${outer} inner arrays + 1 outer), so a cold read\n` +
      `  is O(elements) and only a warm read is O(1). Any change replaces the whole\n` +
      `  value and invalidates every one of those entries.`
  );
}

// ===========================================================================
if (section("Broadcast cost vs. number of watchers")) {
  const shape = wideNormalized(QUICK ? 200 : 2000);
  const watcherCounts = QUICK ? [1, 25] : [1, 10, 50, 200];
  const changed = {
    feed: shape.data.feed.map((item, i) =>
      i === 0 ? { ...item, f0: "CHANGED" } : item
    ),
  };
  const otherQuery = gql`
    query Other {
      unrelated {
        __typename
        id
        v
      }
    }
  `;
  const otherData = { unrelated: { __typename: "Other", id: "o1", v: 1 } };

  // Every watch is registered with `immediate: true`, as in steady state: its
  // first broadcast computes (and warms) the optimistic read and records
  // `lastDiff`, so later broadcasts go through the real equality gate,
  // `equal(lastDiff.result, diff.result)`, before calling the callback.
  // Each watch gets its OWN callback, as each ObservableQuery does: the
  // maybeBroadcastWatch memo key includes the callback, so watches sharing
  // query, variables AND callback would collapse into a single broadcast.
  const watchAll = (cache, queries) => {
    for (const query of queries) {
      cache.watch({ query, optimistic: true, immediate: true, callback() {} });
    }
    return cache;
  };

  const rows = [];
  for (const w of watcherCounts) {
    const queries = Array.from({ length: w }, () => shape.query);
    const setup = () => watchAll(written(shape), queries);

    const relevant = bench(`broadcast ${w} watchers, relevant write`, {
      setup,
      run: (cache) => cache.writeQuery({ query: shape.query, data: changed }),
    });

    const irrelevant = bench(`broadcast ${w} watchers, unrelated write`, {
      setup,
      run: (cache) => cache.writeQuery({ query: otherQuery, data: otherData }),
    });

    rows.push([w, w, { relevant: relevant, unrelated: irrelevant }]);
  }
  table(
    `one write with W watchers registered on the same query (N = ${shape.data.feed.length} items)`,
    ["relevant", "unrelated"],
    rows,
    "W"
  );
  note(
    `  "unrelated" is the memo-gate path: the watches are not dirty, so\n` +
      `  maybeBroadcastWatch returns its memoized value and no diff is computed; each\n` +
      `  watch costs one cache-key construction. "relevant" dirties every watch: the\n` +
      `  first one re-reads the invalidated entries, the others get memo hits, and\n` +
      `  every one of them then runs equal(lastDiff.result, diff.result), which walks\n` +
      `  the rebuilt feed array (N elements) even though each element is ===.`
  );

  // Watchers on the SAME document share StoreReader memo entries. The
  // "distinct" documents below select exactly the same fields and differ only
  // by operation name, so any difference is document identity, not workload.
  const distinctQueries = Array.from(
    { length: 50 },
    (_, i) => gql`
      query Distinct${i} {
        feed {
          __typename
          id
          ${shape.scalarFields.join("\n          ")}
        }
      }
    `
  );
  const sameQueries = Array.from({ length: 50 }, () => shape.query);
  const run = (cache) => cache.writeQuery({ query: shape.query, data: changed });
  const same = bench("broadcast 50 identical watches", {
    setup: () => watchAll(written(shape), sameQueries),
    run,
  });
  // Each rep of the two distinct-document cases takes seconds (setup included),
  // so they use fewer repetitions than the default.
  const slow = { reps: QUICK ? 3 : 9, warmup: 1 };
  const distinct = bench("broadcast 50 distinct-document watches", {
    setup: () => watchAll(written(shape), distinctQueries),
    run,
    ...slow,
  });
  // The same 50 distinct documents with the executeSelectionSet limit raised
  // far above the 50 x (N + 1) entries they need, to separate the cost of not
  // sharing memo entries from the LRU cliff of section 9.
  const distinctRoomy = withCacheSize(
    "inMemoryCache.executeSelectionSet",
    200_000,
    () =>
      bench("broadcast 50 distinct-document watches, limit 200 000", {
        setup: () => watchAll(written(shape), distinctQueries),
        run,
        ...slow,
      })
  );
  const entries = 50 * (shape.data.feed.length + 1);
  note(
    `  50 watchers on the SAME document:                       ${fmt(same)}\n` +
      `  50 watchers on 50 DISTINCT documents:                   ${fmt(distinct)}  (${(distinct / same).toFixed(1)}x)\n` +
      `  the same, executeSelectionSet limit raised to 200 000:  ${fmt(distinctRoomy)}  (${(distinctRoomy / same).toFixed(1)}x)\n` +
      `  Memo entries are keyed by selection-set NODE identity, so identical but\n` +
      `  separately-parsed documents share nothing: every watcher re-reads on its\n` +
      `  own (the raised-limit line). ` +
      (entries > 50000 ?
        `With the default limit the 50 documents also\n` +
        `  need ${entries} executeSelectionSet entries, over the 50 000 limit, so every\n` +
        `  broadcast additionally pays the LRU cliff of section 9 (the default line).`
      : `The 50 documents need ${entries} executeSelectionSet\n` +
        `  entries here, under the 50 000 limit, so the two lines should agree.`)
  );
}

// ===========================================================================
if (section("Transactions, optimistic layers, and layer depth")) {
  const shape = wideNormalized(QUICK ? 200 : 2000);
  const layerCounts = QUICK ? [1, 4] : [1, 4, 16, 64];
  // Every optimistic layer writes one field of one entity (Item:i0.f0), as an
  // optimistic mutation response typically does. The list itself is untouched,
  // so an optimistic read still returns all N items.
  const itemFragment = gql`
    fragment ItemF0 on Item {
      f0
    }
  `;
  const addLayer = (cache, i) =>
    cache.recordOptimisticTransaction((c) => {
      c.writeFragment({
        id: "Item:i0",
        fragment: itemFragment,
        data: { __typename: "Item", f0: `opt${i}` },
      });
    }, `layer-${i}`);

  const rows = [];
  for (const layers of layerCounts) {
    const stack = (cache) => {
      for (let i = 0; i < layers; i++) addLayer(cache, i);
      return cache;
    };

    const addRemove = bench(`add+remove ${layers} layers`, {
      setup: () => written(shape),
      run: (cache) => {
        for (let i = 0; i < layers; i++) addLayer(cache, i);
        for (let i = 0; i < layers; i++) cache.removeOptimistic(`layer-${i}`);
      },
    });

    // The optimistic memo set is cold after stacking: nothing has read it yet.
    const readThroughCold = bench(`optimistic cold read through ${layers} layers`, {
      setup: () => stack(written(shape)),
      run: (cache) =>
        cache.diff({
          query: shape.query,
          optimistic: true,
          returnPartialData: true,
        }),
    });

    const readThrough = bench(`optimistic read through ${layers} layers`, {
      setup: () => {
        const cache = stack(written(shape));
        cache.diff({ query: shape.query, optimistic: true, returnPartialData: true });
        return cache;
      },
      run: (cache) =>
        cache.diff({
          query: shape.query,
          optimistic: true,
          returnPartialData: true,
        }),
    });

    const removeBottom = bench(`remove BOTTOM of ${layers} layers`, {
      setup: () => stack(written(shape)),
      run: (cache) => cache.removeOptimistic("layer-0"),
    });

    // Unwinding order is the whole story: LIFO pops the top layer each time,
    // FIFO removes the bottom and replays everything above it.
    const teardownLifo = bench(`unwind ${layers} layers LIFO`, {
      setup: () => stack(written(shape)),
      run: (cache) => {
        for (let i = layers - 1; i >= 0; i--) cache.removeOptimistic(`layer-${i}`);
      },
    });

    const teardownFifo = bench(`unwind ${layers} layers FIFO`, {
      setup: () => stack(written(shape)),
      run: (cache) => {
        for (let i = 0; i < layers; i++) cache.removeOptimistic(`layer-${i}`);
      },
    });

    rows.push([
      layers,
      layers,
      {
        "add+remove": addRemove,
        "cold read": readThroughCold,
        "warm read": readThrough,
        "remove bottom": removeBottom,
        "unwind LIFO": teardownLifo,
        "unwind FIFO": teardownFifo,
      },
    ]);
  }
  table(
    `L stacked optimistic layers over a ${QUICK ? 200 : 2000}-item list, each writing Item:i0.f0`,
    [
      "add+remove",
      "cold read",
      "warm read",
      "remove bottom",
      "unwind LIFO",
      "unwind FIFO",
    ],
    rows,
    "L"
  );
  note(
    `  "remove bottom" is the expensive removal: removing a layer that is not on\n` +
      `  top rebuilds every layer above it (Layer.removeLayer -> parent.addLayer ->\n` +
      `  new Layer -> replay), so it costs L - 1 replays of a layer's update.\n` +
      `\n` +
      `  Compare the last two columns: unwinding the SAME stack costs O(L) cheap\n` +
      `  recursive calls per pop from the top (O(L^2) calls in total, no replays),\n` +
      `  and O(L^2) REPLAYS when removing from the bottom, because every FIFO removal\n` +
      `  replays the layers above it. "add+remove" uses the FIFO order, which is why\n` +
      `  it inherits the same quadratic scale column.\n` +
      `\n` +
      `  "cold read" is the first optimistic read after stacking: every field read\n` +
      `  walks down the layer chain until a store holds the field, O(L) per field.\n` +
      `  "warm read" is FLAT in L: it is a memo hit at the top of the chain and never\n` +
      `  walks the layers at all.`
  );

  // Batching: one broadcast vs. N broadcasts. Each write changes one field of a
  // different item, so the watched list keeps all its items.
  const writes = QUICK ? 20 : 100;
  const batchSetup = () => {
    const cache = written(shape);
    cache.watch({
      query: shape.query,
      optimistic: true,
      immediate: true,
      callback() {},
    });
    return cache;
  };
  const writeItems = (c) => {
    for (let i = 0; i < writes; i++) {
      c.writeFragment({
        id: `Item:i${i}`,
        fragment: itemFragment,
        data: { __typename: "Item", f0: `v${i}` },
      });
    }
  };
  const unbatched = bench(`${writes} separate writes (${writes} broadcasts)`, {
    setup: batchSetup,
    run: writeItems,
  });
  const batched = bench(`${writes} writes in one batch (1 broadcast)`, {
    setup: batchSetup,
    run: (cache) => cache.batch({ update: writeItems }),
  });
  note(
    `  ${writes} writes, each changing one field of a different item, 1 watcher on a\n` +
      `  ${QUICK ? 200 : 2000}-item list:\n` +
      `    unbatched: ${fmt(unbatched)}\n` +
      `    batched:   ${fmt(batched)}   (${(unbatched / batched).toFixed(1)}x faster)\n` +
      `  The writes cost the same either way; the saving is the avoided broadcasts.\n` +
      `  Unbatched, every write dirties the watch, and each broadcast re-reads the\n` +
      `  list (O(N), section 2) and compares it with the previous result (O(N)).\n` +
      `  Batched, the watch is broadcast once, after all ${writes} writes.`
  );
}

// ===========================================================================
if (section("Optimistic reads maintain a SECOND set of memo entries")) {
  const shape = wideNormalized(QUICK ? 200 : 2000);
  const cache = written(shape);
  const size = () => memoSizes(cache).selectionSets;

  const afterWrite = size();
  cache.diff({ query: shape.query, optimistic: false, returnPartialData: true });
  const afterRoot = size();
  cache.diff({ query: shape.query, optimistic: true, returnPartialData: true });
  const afterOptimistic = size();

  const a = cache.diff({
    query: shape.query,
    optimistic: false,
    returnPartialData: true,
  });
  const b = cache.diff({
    query: shape.query,
    optimistic: true,
    returnPartialData: true,
  });

  const c2 = new InMemoryCache();
  note(
    `  InMemoryCache.init() sets this.optimisticData = rootStore.stump, NOT this.data:\n` +
      `    optimisticData === data      : ${c2["optimisticData"] === c2["data"]}\n` +
      `    optimisticData constructor   : ${c2["optimisticData"].constructor.name}\n` +
      `    groups are the same object   : ${c2["optimisticData"].group === c2["data"].group}\n` +
      `    optimistic group's parent    : ${c2["optimisticData"].group["parent"] === c2["data"].group ? "the root group" : "something else"}\n` +
      `\n  executeSelectionSet memo entries, ${QUICK ? 200 : 2000}-entity list, ZERO optimistic layers:\n` +
      `    after write                  : ${afterWrite}\n` +
      `    after optimistic:false diff  : ${afterRoot}\n` +
      `    after optimistic:true  diff  : ${afterOptimistic}   (+${afterOptimistic - afterRoot} new)\n` +
      `    root result === optimistic result : ${a.result === b.result}\n` +
      `  A query read both ways therefore costs TWO full sets of memo entries.\n` +
      `  ObservableQuery always watches with optimistic: true, its notify() compares\n` +
      `  that diff with an optimistic: false one, and readQuery / readFragment default\n` +
      `  to optimistic: false. Budget memo capacity accordingly.`
  );

  // What the first optimistic read costs when only the root read is warm.
  const coldOptimistic = bench("first optimistic diff (root read warm)", {
    setup: () => {
      const c = written(shape);
      c.readQuery({ query: shape.query });
      return c;
    },
    run: (c) =>
      c.diff({ query: shape.query, optimistic: true, returnPartialData: true }),
  });
  const warmOptimistic = (() => {
    const c = written(shape);
    c.readQuery({ query: shape.query });
    c.diff({ query: shape.query, optimistic: true, returnPartialData: true });
    return bench("warm optimistic diff", {
      run: () =>
        c.diff({
          query: shape.query,
          optimistic: true,
          returnPartialData: true,
        }),
    });
  })();
  note(
    `  first optimistic diff after a warm root read: ${fmt(coldOptimistic)}\n` +
      `  warm optimistic diff:                        ${fmt(warmOptimistic)}\n` +
      `  A warm root read buys the optimistic read nothing.`
  );
}

// ===========================================================================
if (section("The memo LRU cliff (executeSelectionSet max = 50 000)")) {
  const limit = 50000;
  const groups = 100;
  const rowCounts = QUICK ? [100, 500] : [100, 400, 490, 500, 600];

  const rows = [];
  for (const perGroup of rowCounts) {
    const shape = nestedArrays(groups, perGroup);
    const entities = groups * perGroup + groups + 1;
    const cache = written(shape);
    cache.readQuery({ query: shape.query });
    const size = memoSizes(cache).selectionSets;
    const warm = bench(`warm read, ${entities} entities`, {
      run: () => cache.readQuery({ query: shape.query }),
    });
    rows.push([entities, entities, { "memo size": size, "warm read": warm }]);
  }

  if (!JSON_OUT) {
    console.log(`\n  Warm read cost as the entity count crosses the memo limit`);
    console.log(
      `  ${"entities".padStart(9)} ${"memo entries".padStart(13)} ${"warm read".padStart(13)} ${"over limit?".padStart(12)}`
    );
    console.log(`  ${"-".repeat(52)}`);
    for (const [, entities, values] of rows) {
      console.log(
        `  ${String(entities).padStart(9)} ${String(values["memo size"]).padStart(13)} ${fmt(values["warm read"]).padStart(13)} ${(entities > limit ? "YES" : "no").padStart(12)}`
      );
    }
  }
  // The same mechanism at a small limit, counted instead of timed: how many
  // executeSelectionSet entries does each "warm" read recompute?
  const recomputed = withCacheSize("inMemoryCache.executeSelectionSet", 1000, () =>
    [900, 1100, 1500, 3000].map((n) => {
      const shape = wideNormalized(n, 1);
      const c = written(shape);
      const counts = countRecomputes(c);
      c.readQuery({ query: shape.query });
      c.readQuery({ query: shape.query });
      counts.reset();
      c.readQuery({ query: shape.query });
      return `${n + 1} entities -> ${counts.selectionSets}`;
    })
  );
  note(
    `  optimism trims an LRU only when the outermost memoized call returns, so a\n` +
      `  read never loses entries during its own traversal. The trim afterwards\n` +
      `  evicts the overflow (the oldest entries: the first items read), and\n` +
      `  evicting an entry dirties its parents. The next "warm" read therefore\n` +
      `  re-walks the list (O(N) memo lookups) and recomputes the evicted entities,\n` +
      `  which become the newest, so the trim evicts the next-oldest ones. With\n` +
      `  the limit set to 1 000, entries recomputed per warm read of a flat list:\n` +
      `    ${recomputed.join("; ")}\n` +
      `  (the overflow plus ROOT_QUERY). The cliff is abrupt rather than gradual:\n` +
      `  below the limit the read is microseconds, above it milliseconds. Raise it\n` +
      `  with cacheSizes["inMemoryCache.executeSelectionSet"], or do not read that\n` +
      `  many entities in one query.`
  );
}

// ===========================================================================
if (section("Field-key construction: arguments and canonicalStringify")) {
  const argCounts = QUICK ? [0, 8] : [0, 2, 8, 24];
  const rows = [];
  for (const k of argCounts) {
    const argDefs = Array.from({ length: k }, (_, i) => `$a${i}: String`).join(", ");
    const argUse = Array.from({ length: k }, (_, i) => `a${i}: $a${i}`).join(", ");
    const query = gql`
      query Args${argDefs ? `(${argDefs})` : ""} {
        search${argUse ? `(${argUse})` : ""} {
          __typename
          id
          title
        }
      }
    `;
    const variables = Object.fromEntries(
      Array.from({ length: k }, (_, i) => [`a${i}`, `value-${i}`])
    );
    const data = {
      search: Array.from({ length: 50 }, (_, i) => ({
        __typename: "Hit",
        id: `h${i}`,
        title: `t${i}`,
      })),
    };

    const w = bench(`write with ${k} args`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query, data, variables }),
    });

    const rc = bench(`read cold with ${k} args`, {
      setup: () => {
        const c = freshCache();
        c.writeQuery({ query, data, variables });
        c.gc({ resetResultCache: true });
        return c;
      },
      run: (c) => c.readQuery({ query, variables }),
    });

    rows.push([k, Math.max(k, 1), { write: w, "read cold": rc }]);
  }
  table(
    "k arguments on the one root field over a 50-item result",
    ["write", "read cold"],
    rows,
    "k"
  );

  // Nested object arguments: canonicalStringify has to sort recursively.
  // The payload is deliberately tiny (one hit) so the key-building cost, not
  // the result traversal, dominates the measurement.
  const nestedArgQuery = gql`
    query NestedArgs($filter: FilterInput) {
      search(filter: $filter) {
        __typename
        id
        title
      }
    }
  `;
  const makeFilter = (depth) => {
    let f = { z: 1, a: 2, m: 3 };
    for (let i = 0; i < depth; i++) f = { z: 1, nested: f, a: 2 };
    return f;
  };
  const oneHit = {
    search: [{ __typename: "Hit", id: "h0", title: "t0" }],
  };
  const nestedRows = (QUICK ? [1, 16] : [1, 8, 32, 128]).map((depth) => {
    const variables = { filter: makeFilter(depth) };
    const w = bench(`write nested arg depth=${depth}`, {
      setup: () => freshCache(),
      run: (c) =>
        c.writeQuery({ query: nestedArgQuery, data: oneHit, variables }),
    });
    // canonicalStringify memoizes only the SORTED KEY ORDER of each object
    // shape, never the serialized output, so reusing the same variables object
    // should buy nothing over a fresh, structurally equal one each call.
    const wFresh = bench(`write nested arg depth=${depth}, fresh vars`, {
      setup: () => freshCache(),
      run: (c) =>
        c.writeQuery({
          query: nestedArgQuery,
          data: oneHit,
          variables: { filter: makeFilter(depth) },
        }),
    });
    return [depth, depth, { write: w, "fresh vars": wFresh }];
  });
  table(
    "one root field whose argument is an object nested d levels deep (1-item result)",
    ["write", "fresh vars"],
    nestedRows,
    "d"
  );

  const c = freshCache();
  c.writeQuery({
    query: nestedArgQuery,
    data: oneHit,
    variables: { filter: makeFilter(2) },
  });
  const key = Object.keys(c.extract().ROOT_QUERY).find((k) =>
    k.startsWith("search")
  );
  note(`  Resulting store field key (note the sorted, fully-serialized args):\n    ${key}`);
  note(
    `  The arguments sit on the single root field, so their key is built a\n` +
      `  constant number of times per operation; next to the 50-item traversal even\n` +
      `  24 of them are lost in the noise. Key construction is O(size of the\n` +
      `  arguments) per field occurrence: the same arguments on a field of every\n` +
      `  list item would be paid once per item.`
  );
}

// ===========================================================================
if (section("keyFields: identity extraction cost")) {
  // Every Book carries an `id`, so the default configuration normalizes it too:
  // the four normalizing rows differ only in how the id is computed.
  const data = {
    books: Array.from({ length: QUICK ? 200 : 2000 }, (_, i) => ({
      __typename: "Book",
      id: `b${i}`,
      isbn: `isbn-${i}`,
      title: `Title ${i}`,
      author: { __typename: "Author", name: `Author ${i}` },
      published: { __typename: "Pub", year: 2000 + (i % 20), city: `C${i % 7}` },
    })),
  };
  const query = gql`
    query Books {
      books {
        __typename
        id
        isbn
        title
        author {
          __typename
          name
        }
        published {
          __typename
          year
          city
        }
      }
    }
  `;

  const configs = {
    "default (__typename + id)": {},
    "keyFields: ['isbn']": {
      typePolicies: { Book: { keyFields: ["isbn"] } },
    },
    "keyFields: ['isbn', 'title']": {
      typePolicies: { Book: { keyFields: ["isbn", "title"] } },
    },
    "keyFields: isbn + author.name": {
      typePolicies: { Book: { keyFields: ["isbn", "author", ["name"]] } },
    },
    "keyFields: false (embedded)": {
      typePolicies: { Book: { keyFields: false } },
    },
  };

  const rows = [];
  for (const [label, config] of Object.entries(configs)) {
    const w = bench(`write ${label}`, {
      setup: () => freshCache(config),
      run: (c) => c.writeQuery({ query, data }),
    });
    const rw = bench(`rewrite identical ${label}`, {
      setup: () => {
        const c = freshCache(config);
        c.writeQuery({ query, data });
        return c;
      },
      run: (c) => c.writeQuery({ query, data }),
    });
    const probe = freshCache(config);
    probe.writeQuery({ query, data });
    const entries = Object.keys(probe.extract()).length;
    rows.push([label, 1, { write: w, rewrite: rw, entries }]);
  }
  const baseline = rows[0][2];
  if (!JSON_OUT) {
    console.log(`\n  Book list (${data.books.length} books) write cost by keyFields configuration`);
    console.log(
      `  ${"config".padEnd(30)} ${"store entries".padStart(13)} ${"write".padStart(11)} ${"vs default".padStart(11)} ${"rewrite".padStart(11)} ${"vs default".padStart(11)}`
    );
    console.log(`  ${"-".repeat(92)}`);
    for (const [label, , values] of rows) {
      console.log(
        `  ${label.padEnd(30)} ${String(values.entries).padStart(13)} ${fmt(values.write).padStart(11)} ${`${(values.write / baseline.write).toFixed(2)}x`.padStart(11)} ${fmt(values.rewrite).padStart(11)} ${`${(values.rewrite / baseline.rewrite).toFixed(2)}x`.padStart(11)}`
      );
    }
  }
  note(
    `  Every object with a selection set pays identify() on write. The default\n` +
      `  key function reads two properties and concatenates a string. A keyFields\n` +
      `  array runs a compiled key function instead: one readField per key path\n` +
      `  (the nested path reads author, then author.name), a fresh DeepMerger to\n` +
      `  collect the key object, and JSON.stringify of that object. keyFields: false\n` +
      `  still calls identify(), whose key function returns undefined at once; the\n` +
      `  books then stay embedded in ROOT_QUERY.books, which skips per-book staging\n` +
      `  and store.merge but makes every rewrite deep-compare the whole list.`
  );
}

// ===========================================================================
if (section("Eviction, garbage collection and extract")) {
  const sizes = QUICK ? [500, 2000] : [1000, 5000, 20000];
  const rows = [];
  for (const n of sizes) {
    const shape = wideNormalized(n);

    const evictOne = bench(`evict 1 of ${n}`, {
      setup: () => written(shape),
      run: (c) => c.evict({ id: "Item:i0" }),
    });

    const evictField = bench(`evict 1 field of ${n}`, {
      setup: () => written(shape),
      run: (c) => c.evict({ id: "Item:i0", fieldName: "f0" }),
    });

    // Right after a write, every entity's findChildRefIds memo is empty, so gc
    // walks every field of every entity. A second gc with no write in between
    // reuses those memos and only walks the store and its references.
    const gcNoop = bench(`gc with nothing to collect (${n})`, {
      setup: () => written(shape),
      run: (c) => c.gc(),
    });

    const gcNoopAgain = bench(`gc again with nothing to collect (${n})`, {
      setup: () => {
        const c = written(shape);
        c.gc();
        return c;
      },
      run: (c) => c.gc(),
    });

    const gcCollect = bench(`gc after unreachable ${n}`, {
      setup: () => {
        const c = written(shape);
        // Detach the whole list from ROOT_QUERY: every Item becomes unreachable.
        // (writeQuery retains only ROOT_QUERY, not the items it wrote.)
        c.modify({ fields: { feed: (_, { DELETE }) => DELETE } });
        return c;
      },
      run: (c) => c.gc(),
    });

    const extract = bench(`extract ${n}`, {
      setup: () => written(shape),
      run: (c) => c.extract(),
    });

    const restore = (() => {
      const snapshot = written(shape).extract();
      return bench(`restore ${n}`, {
        setup: () => freshCache(),
        run: (c) => c.restore(snapshot),
      });
    })();

    // The same data written with writeQuery, measured here so that restore
    // and write are compared in the same process state.
    const write = bench(`write for restore comparison ${n}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });

    rows.push([
      n,
      n,
      {
        "evict entity": evictOne,
        "evict field": evictField,
        "gc noop": gcNoop,
        "gc noop again": gcNoopAgain,
        "gc collect": gcCollect,
        extract,
        restore,
        "write same": write,
      },
    ]);
  }
  table(
    "lifecycle operations over a list of N entities (store: S = N + 1 entries)",
    [
      "evict entity",
      "evict field",
      "gc noop",
      "gc noop again",
      "gc collect",
      "extract",
      "restore",
      "write same",
    ],
    rows,
    "N"
  );
  note(
    `  gc() is a full mark-and-sweep: it copies the store, walks every reachable\n` +
      `  entity and deletes the rest, so it is O(S) EVEN WHEN IT COLLECTS NOTHING.\n` +
      `  "gc noop" runs right after a write, when no entity's child-reference memo\n` +
      `  is valid, so it also walks every field of every entity; "gc noop again"\n` +
      `  reuses those memos. restore() is much cheaper than a write of the same data\n` +
      `  because it skips normalization entirely: the snapshot is already normalized.`
  );
}

// ===========================================================================
if (section("Result caching off: what memoization is worth")) {
  const n = QUICK ? 500 : 5000;
  const shape = wideNormalized(n);

  const withCaching = (() => {
    const c = written(shape);
    c.readQuery({ query: shape.query });
    return bench(`read warm, resultCaching on (N=${n})`, {
      run: () => c.readQuery({ query: shape.query }),
    });
  })();

  const withoutCaching = (() => {
    const c = written(shape, { resultCaching: false });
    c.readQuery({ query: shape.query });
    return bench(`read warm, resultCaching off (N=${n})`, {
      run: () => c.readQuery({ query: shape.query }),
    });
  })();

  const writeOn = bench(`write, resultCaching on (N=${n})`, {
    setup: () => freshCache(),
    run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
  });
  const writeOff = bench(`write, resultCaching off (N=${n})`, {
    setup: () => freshCache({ resultCaching: false }),
    run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
  });

  note(
    `  N=${n} entities:\n` +
      `    read warm,  resultCaching: true   ${fmt(withCaching)}\n` +
      `    read warm,  resultCaching: false  ${fmt(withoutCaching)}   (${(withoutCaching / withCaching).toFixed(0)}x slower)\n` +
      `    write,      resultCaching: true   ${fmt(writeOn)}\n` +
      `    write,      resultCaching: false  ${fmt(writeOff)}   (${(writeOff / writeOn).toFixed(2)}x)\n` +
      `  Memoization is a read-path optimization paid for on the write path through\n` +
      `  dependency bookkeeping. The read-side win is orders of magnitude; the\n` +
      `  write-side cost is a modest constant factor.`
  );
}

// ===========================================================================
if (
  section("Development-build overhead (maybeDeepFreeze + warnAboutDataLoss)") ||
  IS_CHILD
) {
  // Both builds are measured in FRESH child processes that run only this
  // section. Measuring the production side here, at the end of a long process,
  // would compare a process that has run every other section against a fresh
  // one, and the difference in process state (JIT feedback, heap) can be
  // larger than the difference between the builds.
  const n = QUICK ? 500 : 5000;
  const shape = wideNormalized(n);

  if (IS_CHILD) {
    const write = bench(`build write N=${n}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const readCold = bench(`build read cold N=${n}`, {
      setup: () => {
        const c = written(shape);
        c.gc({ resetResultCache: true });
        return c;
      },
      run: (c) => c.readQuery({ query: shape.query }),
    });
    console.log(
      `__BUILD_RESULT__ ${JSON.stringify({ write, readCold, frozen: isDevBuild() })}`
    );
  } else {
    const measureBuild = (dev) => {
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          ...(dev ? ["--conditions=development"] : []),
          fileURLToPath(import.meta.url),
          ...(QUICK ? ["--quick"] : []),
          "--child-build",
        ],
        { encoding: "utf8", timeout: 600_000 }
      );
      const line = (child.stdout || "")
        .split("\n")
        .find((l) => l.startsWith("__BUILD_RESULT__"));
      if (!line) {
        throw new Error(
          `Could not measure the ${dev ? "development" : "production"} build (child exited ${child.status}):\n${child.stderr}`
        );
      }
      return JSON.parse(line.slice("__BUILD_RESULT__".length));
    };
    let prod;
    let dev;
    if (AGGREGATE) {
      const get = (label) => AGGREGATE.get(label).median;
      prod = {
        write: get(`prod-build write N=${n}`),
        readCold: get(`prod-build read cold N=${n}`),
        frozen: false,
      };
      dev = {
        write: get(`dev-build write N=${n}`),
        readCold: get(`dev-build read cold N=${n}`),
        frozen: AGGREGATE.devFrozen,
      };
    } else {
      prod = measureBuild(false);
      dev = measureBuild(true);
      results.push({ label: `prod-build write N=${n}`, ns: prod.write });
      results.push({ label: `prod-build read cold N=${n}`, ns: prod.readCold });
      results.push({ label: `dev-build write N=${n}`, ns: dev.write });
      results.push({ label: `dev-build read cold N=${n}`, ns: dev.readCold });
      devFrozen = dev.frozen;
    }
    note(
      `  N=${n} entities, production build vs. development build (each measured\n` +
        `  in a fresh process that runs only this section):\n` +
        `    write     prod ${fmt(prod.write).padStart(10)}   dev ${fmt(dev.write).padStart(10)}   ${(dev.write / prod.write).toFixed(2)}x\n` +
        `    read cold prod ${fmt(prod.readCold).padStart(10)}   dev ${fmt(dev.readCold).padStart(10)}   ${(dev.readCold / prod.readCold).toFixed(2)}x\n` +
        `    results frozen: prod=${isDevBuild()} dev=${dev.frozen}\n` +
        `  The development build clones every scalar field value on write, runs\n` +
        `  warnAboutDataLoss on every write, and deep-freezes every value it reads\n` +
        `  and every result it computes. deepFreeze does NOT stop at objects that\n` +
        `  are already frozen: it skips re-freezing them but still walks all their\n` +
        `  children, so each recomputed memo entry walks its whole result subtree.`
    );
  }
}

if (IS_CHILD) process.exit(0);

// ===========================================================================
// Summary (always printed, even when --sections selects a subset)
// ===========================================================================
++sectionNo;
if (sectionNo - 1 !== SECTION_COUNT) {
  throw new Error(
    `SECTION_COUNT is ${SECTION_COUNT} but the probe has ${sectionNo - 1} sections`
  );
}
if (!JSON_OUT) {
  console.log(
    `\n${"=".repeat(86)}\n${sectionNo}. Summary: slowest measurements\n${"=".repeat(86)}`
  );
}
const meta = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  quick: QUICK,
  repsPerMeasurement: REPS,
  warmupsPerMeasurement: WARMUP,
  runs: RUNS,
};
if (JSON_OUT) {
  if (AGGREGATE) {
    console.log(JSON.stringify(aggregateToJson(AGGREGATE), null, 2));
  } else {
    console.log(JSON.stringify({ meta, devFrozen, results }, null, 2));
  }
} else {
  const all =
    AGGREGATE ?
      [...AGGREGATE].map(([label, a]) => ({ label, ns: a.median }))
    : results;
  const top = [...all].sort((a, b) => b.ns - a.ns).slice(0, 15);
  console.log();
  for (const { label, ns } of top) {
    console.log(`  ${fmt(ns).padStart(12)}  ${label}`);
  }
  const measuredOn = AGGREGATE?.meta ?? meta;
  console.log(
    `\n  ${all.length} measurements. Node ${measuredOn.node} on ${measuredOn.platform}.`
  );
  console.log(
    `  Each measurement: median of ${REPS} timed repetitions after ${WARMUP} untimed warm-ups` +
      (AGGREGATE ?
        `,\n  then the median of those medians across ${AGGREGATE.runCount} runs; every run measures each\n  section in its own fresh process.`
      : `\n  (single process; pass --runs=R to measure every section in fresh processes, R times).`)
  );
  if (AGGREGATE) {
    // Run-to-run spread: (max - min) / median of the per-run medians.
    const spreads = [...AGGREGATE]
      .map(([label, a]) => ({
        label,
        spread: (a.max - a.min) / a.median,
        a,
      }))
      .sort((x, y) => x.spread - y.spread);
    const pct = (q) => spreads[Math.min(spreads.length - 1, Math.floor(q * spreads.length))].spread;
    console.log(
      `\n  Run-to-run spread, (max - min) / median across the ${AGGREGATE.runCount} runs:\n` +
        `    median measurement: ${(pct(0.5) * 100).toFixed(0)}%   90th percentile: ${(pct(0.9) * 100).toFixed(0)}%\n` +
        `    noisiest measurements:`
    );
    for (const { label, spread, a } of spreads.slice(-8).reverse()) {
      console.log(
        `    ${`${(spread * 100).toFixed(0)}%`.padStart(6)}  ${label}  (${fmt(a.min)} .. ${fmt(a.max)})`
      );
    }
  }
  console.log(
    `  Development build: ${isDevBuild()} (true = results are deep-frozen)`
  );
}
