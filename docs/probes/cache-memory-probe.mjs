/**
 * Executable memory probe for Apollo Client's `InMemoryCache` (v4.2.11) and this
 * repository's `InMemoryCacheRs`: the companion of the performance probe, for
 * memory instead of time.
 *
 *   node --expose-gc docs/probes/cache-memory-probe.mjs --runs=5
 *   node --expose-gc docs/probes/cache-memory-probe.mjs --quick --sections=1,3
 *   node --expose-gc docs/probes/cache-memory-probe.mjs --cache=rs
 *   node --expose-gc docs/probes/cache-memory-probe.mjs --json-out=result.json
 *   node --expose-gc docs/probes/cache-memory-probe.mjs --runs=5 --save=agg.json
 *   node --expose-gc docs/probes/cache-memory-probe.mjs --load=agg.json
 *
 * The flags mean what they mean in `cache-performance-probe.mjs`, so the
 * benchmark scripts (`scripts/bench/`) run either probe the same way.
 *
 * What it measures
 * ----------------
 * - **Retained bytes**: what the cache keeps alive, between two settled heaps:
 *   the store, the result memo, watches, layers. A cache that holds WASM memory
 *   is counted by the bytes its allocator has in use (see `memory-harness.mjs`).
 * - **Allocated bytes**: the garbage an operation creates, whether or not it
 *   survives. Allocation drives garbage-collection pauses, and it is the part of
 *   memory that a faster write path should shrink most.
 * - **Checks**: properties that must hold, such as memory returning after an
 *   eviction, a dropped cache, or a steady workload, which a ratio cannot
 *   express because the healthy value is zero.
 *
 * Method
 * ------
 * Every section runs in its own process with `--runs`, as in the performance
 * probe, because a heap carries state from one workload to the next. Before
 * measuring, each section runs its workload once at a small size, so that
 * compiled code, parsed documents and module-level caches are not charged to
 * the cache. Payloads are built inside the measured step and dropped after it, so
 * a retained measurement counts what the cache keeps of them (Apollo stores leaf
 * values by reference) and nothing the probe keeps. Retained measurements are
 * deterministic to within a few KiB; allocation is the median of several
 * repetitions. The label set does not depend on `--quick`, which only lowers the
 * repetition and cycle counts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "graphql";
import { gql } from "graphql-tag";

import {
  allocation,
  drop,
  fmtBytes,
  footprint,
  hold,
  median,
  requireGc,
  settle,
  slope,
  snapshot,
  use,
} from "./memory-harness.mjs";
import { cacheName, InMemoryCache, wasmHeap } from "./select-cache.mjs";

requireGc();

const QUICK = process.argv.includes("--quick");
const argValue = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};
/** `--json-out=FILE` is `--json` written to FILE (stdout carries the cache's output). */
const JSON_FILE = argValue("json-out");
const JSON_OUT = process.argv.includes("--json") || Boolean(JSON_FILE);
const SECTIONS = (() => {
  const arg = argValue("sections");
  return arg ? new Set(arg.split(",").map(Number)) : null;
})();
const RUNS_ARG = argValue("runs");
const RUNS = Math.max(1, Number(RUNS_ARG ?? 1) || 1);
const SAVE_PATH = argValue("save");
const LOAD_PATH = argValue("load");
/** Number of measured sections. */
const SECTION_COUNT = 6;
/** Allocation repetitions: the median is reported. */
const REPS = QUICK ? 3 : 7;
const WARMUP = 2;
const UNIT = "B";

const results = [];
const checks = [];
const seenLabels = new Set();

/**
 * Aggregated values, keyed by label, when this process only REPORTS the medians
 * of `RUNS` measuring processes. Measurements then look their values up.
 */
let AGGREGATE = null;

function claim(label) {
  if (seenLabels.has(label)) {
    throw new Error(`Duplicate measurement label: ${label}`);
  }
  seenLabels.add(label);
}

/** Records a measurement, or looks it up when re-rendering an aggregate. */
function record(label, value, detail = {}) {
  claim(label);
  if (AGGREGATE) {
    const agg = AGGREGATE.results.get(label);
    if (!agg) throw new Error(`No aggregated value for: ${label}`);
    return { value: agg.median, detail: agg.detail ?? {} };
  }
  results.push({ label, value, unit: UNIT, detail });
  return { value, detail };
}

/** Records a check, or looks it up when re-rendering an aggregate. */
function check(label, pass, detail = "") {
  claim(label);
  if (AGGREGATE) {
    const agg = AGGREGATE.checks.get(label);
    if (!agg) throw new Error(`No aggregated check for: ${label}`);
    checks.push({ label, pass: agg.pass, detail: agg.detail });
    return agg.pass;
  }
  checks.push({ label, pass, detail });
  return pass;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let sectionNo = 0;
function section(title) {
  ++sectionNo;
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

/** Prints rows of [first column, ...cells] under a header. */
function table(title, header, rows) {
  if (JSON_OUT) return;
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells) =>
    cells
      .map((c, i) =>
        i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i])
      )
      .join("  ");
  console.log(`\n  ${title}`);
  console.log(`  ${line(header)}`);
  console.log(`  ${"-".repeat(line(header).length)}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

const perItem = (bytes, n) => `${Math.round(bytes / n)} B`;
const count = (n) => n.toLocaleString("en-US").replaceAll(",", " ");

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

/**
 * Retained bytes after each stage of a workload, cumulative from an empty heap.
 * `stages` run in order against one held state object; each is synchronous.
 * The workload runs once first at `warmupStages` (a small size), unmeasured.
 */
async function retainedStages(prefix, stages, warmupStages) {
  if (AGGREGATE) {
    return stages.map((s) => ({
      name: s.name,
      ...record(`${prefix}: ${s.name}`),
    }));
  }
  if (warmupStages) {
    const warm = hold(() => ({}));
    for (const s of warmupStages) use(warm, s.run);
    use(warm, (state) => state.dispose?.());
    drop(warm);
  }
  await settle();
  const base = snapshot();
  const id = hold(() => ({}));
  const out = [];
  for (const s of stages) {
    use(id, s.run);
    await settle();
    const f = footprint(base, snapshot());
    out.push({ name: s.name, ...record(`${prefix}: ${s.name}`, f.total, f) });
  }
  use(id, (state) => state.dispose?.());
  drop(id);
  return out;
}

/** Median allocation of `run(state)` over repetitions; `setup` is not measured. */
function allocated(label, { setup, run }) {
  if (AGGREGATE) return record(label);
  const samples = [];
  for (let i = 0; i < WARMUP + REPS; i++) {
    const id = hold(setup);
    const sample = use(id, (state) => allocation(() => run(state)));
    use(id, (state) => state.dispose?.());
    drop(id);
    if (i >= WARMUP) samples.push(sample);
  }
  const mid = median(samples.map((s) => s.total));
  const chosen = samples.find((s) => s.total === mid) ?? samples[0];
  return record(label, mid, { ...chosen, total: mid });
}

// ---------------------------------------------------------------------------
// Shapes (the performance probe's, so the two probes describe the same data)
// ---------------------------------------------------------------------------

const scalarFieldsOf = (n) => Array.from({ length: n }, (_, i) => `f${i}`);

/** A flat list of `count` normalized entities with `fields` scalar fields (F = fields + 2). */
function wideNormalized(count, fields = 6) {
  const scalarFields = scalarFieldsOf(fields);
  return Array.from({ length: count }, (_, i) => {
    const item = { __typename: "Item", id: `i${i}` };
    for (const f of scalarFields) item[f] = `${f}-value-${i}`;
    return item;
  });
}
const WIDE = gql`
  query Wide {
    feed {
      __typename
      id
      f0
      f1
      f2
      f3
      f4
      f5
    }
  }
`;
const wideData = (count) => ({ feed: wideNormalized(count) });

const WIDE_UNTYPED = gql`
  query WideUntyped {
    feed {
      __typename
      f0
      f1
      f2
      f3
      f4
      f5
    }
  }
`;
/** The same items without an `id`, so they stay embedded in their parent. */
const wideUntypedData = (count) => ({
  feed: wideNormalized(count).map((item) => {
    const embedded = { ...item, __typename: "Embedded" };
    delete embedded.id;
    return embedded;
  }),
});

/** A chain of `depth` normalized entities. */
function deepQuery(depth) {
  let selection = "__typename\n id\n f0\n f1\n f2";
  for (let d = 1; d < depth; d++) {
    selection = `__typename\n id\n f0\n f1\n f2\n child {\n ${selection}\n }`;
  }
  return gql`query Deep { root { ${selection} } }`;
}
function deepData(depth) {
  const build = (d) => {
    const node = {
      __typename: "Node",
      id: `n${d}`,
      f0: `a${d}`,
      f1: `b${d}`,
      f2: `c${d}`,
    };
    if (d < depth - 1) node.child = build(d + 1);
    return node;
  };
  return { root: build(0) };
}

const MATRIX = gql`
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
const matrixData = (outer, inner) => ({
  groups: Array.from({ length: outer }, (_, g) => ({
    __typename: "Group",
    id: `g${g}`,
    rows: Array.from({ length: inner }, (_, r) => ({
      __typename: "Row",
      id: `g${g}r${r}`,
      value: `v${g}-${r}`,
    })),
  })),
});

const SCALAR_MATRIX = gql`
  query ScalarMatrix {
    matrix
  }
`;
const scalarMatrixData = (outer, inner) => ({
  matrix: Array.from({ length: outer }, (_, g) =>
    Array.from({ length: inner }, (_, r) => `${g}:${r}`)
  ),
});

/** One entity whose `blob` field holds a JSON value with no selection set. */
const BLOB = gql`
  query Blob {
    report {
      __typename
      id
      blob
    }
  }
`;
const blobData = (count) => ({
  report: {
    __typename: "Report",
    id: "r1",
    blob: Array.from({ length: count }, (_, i) => ({
      key: `k${i}`,
      value: i,
      tags: [`t${i % 7}`, `u${i % 11}`],
    })),
  },
});

/** A list whose items each select a field with a nested argument object. */
const ARGS = gql`
  query Args($filter: Filter) {
    feed {
      __typename
      id
      price(filter: $filter)
    }
  }
`;
const ARGS_VARIABLES = {
  filter: {
    currency: "EUR",
    region: { country: "DE", zone: { code: "EU-CENTRAL", tier: 2 } },
    flags: ["retail", "wholesale", "promo"],
  },
};
const argsData = (count) => ({
  feed: Array.from({ length: count }, (_, i) => ({
    __typename: "Product",
    id: `p${i}`,
    price: i * 1.5,
  })),
});

const PAGE = gql`
  query Page($page: Int!) {
    feed(page: $page) {
      __typename
      id
      f0
      f1
      f2
      f3
      f4
      f5
    }
  }
`;
const pageData = (page, size) => ({
  feed: wideNormalized(size).map((item) => ({
    ...item,
    id: `p${page}-${item.id}`,
  })),
});

/**
 * A fresh document per call: the same selections in a distinct AST. Parsed with
 * `graphql`'s `parse`, not `gql`: graphql-tag keeps every document it has parsed
 * in a module-level cache, which would charge the probe's own documents to the
 * cache under test.
 */
const distinctDocument = (k) =>
  parse(`query Distinct${k} { feed { __typename id f0 f1 f2 f3 f4 f5 } }`);

const ITEM_F0 = gql`
  fragment ItemF0 on Item {
    f0
  }
`;

const writeWide = (cache, n) =>
  cache.writeQuery({ query: WIDE, data: wideData(n) });
const noop = () => {};

// ===========================================================================
// Multi-run aggregation, --save and --load
// ===========================================================================

async function aggregateRuns() {
  const perLabel = new Map();
  const perCheck = new Map();
  const dir = mkdtempSync(join(tmpdir(), "cache-memory-runs-"));
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
      const file = join(dir, `run-${r}-section-${k}.json`);
      const child = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          fileURLToPath(import.meta.url),
          `--json-out=${file}`,
          `--sections=${k}`,
          `--cache=${cacheName}`,
          ...(QUICK ? ["--quick"] : []),
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 }
      );
      if (child.status !== 0) {
        throw new Error(
          `Measuring run ${r + 1}, section ${k} failed (exit ${child.status}):\n${child.stderr}`
        );
      }
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      for (const { label, value, detail } of parsed.results) {
        if (!perLabel.has(label)) perLabel.set(label, []);
        perLabel.get(label).push({ value, detail });
      }
      for (const { label, pass, detail } of parsed.checks) {
        if (!perCheck.has(label)) perCheck.set(label, []);
        perCheck.get(label).push({ pass, detail });
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  const aggregate = { results: new Map(), checks: new Map(), runCount: RUNS };
  for (const [label, samples] of perLabel) {
    const values = samples.map((s) => s.value);
    const mid = median(values);
    aggregate.results.set(label, {
      median: mid,
      min: Math.min(...values),
      max: Math.max(...values),
      runs: values,
      // The detail of the run whose value is the median (or the closest).
      detail: samples.reduce((a, b) =>
        Math.abs(b.value - mid) < Math.abs(a.value - mid) ? b : a
      ).detail,
    });
  }
  for (const [label, runs] of perCheck) {
    const failed = runs.find((r) => !r.pass);
    aggregate.checks.set(label, {
      pass: !failed,
      passedRuns: runs.filter((r) => r.pass).length,
      runs: runs.length,
      detail: (failed ?? runs[0]).detail,
    });
  }
  return aggregate;
}

function aggregateToJson(aggregate) {
  return {
    meta: {
      probe: "memory",
      cache: cacheName,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      quick: QUICK,
      repsPerMeasurement: REPS,
      runs: aggregate.runCount,
    },
    results: [...aggregate.results].map(([label, a]) => ({
      label,
      unit: UNIT,
      ...a,
    })),
    checks: [...aggregate.checks].map(([label, c]) => ({ label, ...c })),
  };
}

if (LOAD_PATH) {
  const saved = JSON.parse(readFileSync(LOAD_PATH, "utf8"));
  if (saved.meta.quick !== QUICK) {
    throw new Error(
      `${LOAD_PATH} was measured ${saved.meta.quick ? "with" : "without"} --quick; pass the same flag to render it`
    );
  }
  if (saved.meta.cache !== cacheName) {
    throw new Error(
      `${LOAD_PATH} was measured with --cache=${saved.meta.cache}; pass the same flag to render it`
    );
  }
  AGGREGATE = {
    results: new Map(saved.results.map(({ label, ...a }) => [label, a])),
    checks: new Map(saved.checks.map(({ label, ...c }) => [label, c])),
    runCount: saved.meta.runs,
    meta: saved.meta,
  };
} else if (RUNS_ARG) {
  AGGREGATE = await aggregateRuns();
  if (SAVE_PATH) {
    writeFileSync(
      SAVE_PATH,
      `${JSON.stringify(aggregateToJson(AGGREGATE), null, 2)}\n`
    );
  }
}

if (!JSON_OUT) {
  console.log(
    `Memory probe: ${InMemoryCache.name} (--cache=${cacheName}), Node ${process.version}, ${process.platform}/${process.arch}` +
      (AGGREGATE ?
        `, median of ${AGGREGATE.runCount} run(s), each section in a fresh process`
      : ", one run in this process")
  );
}

// ===========================================================================
// 1. Retained footprint vs list breadth
// ===========================================================================

if (
  section("Retained footprint vs list breadth: store, read memo, watched query")
) {
  const stagesFor = (n) => [
    {
      name: "store after write",
      run: (s) => {
        s.cache = new InMemoryCache();
        writeWide(s.cache, n);
      },
    },
    {
      name: "+ read (optimistic: false)",
      run: (s) => void s.cache.readQuery({ query: WIDE }),
    },
    {
      name: "+ watch (optimistic: true)",
      run: (s) => {
        s.unwatch = s.cache.watch({
          query: WIDE,
          optimistic: true,
          immediate: true,
          callback: noop,
        });
        s.dispose = () => s.unwatch();
      },
    },
  ];
  const rows = [];
  const series = [];
  for (const n of [1000, 5000, 20000]) {
    const out = await retainedStages(
      `breadth N=${n}`,
      stagesFor(n),
      stagesFor(100)
    );
    const payload = JSON.stringify(wideData(n)).length;
    rows.push([
      count(n),
      fmtBytes(payload),
      ...out.map((o) => fmtBytes(o.value)),
      perItem(out[2].value, n),
    ]);
    series.push([n, out.map((o) => o.value)]);
  }
  table(
    "Retained bytes, cumulative (F = 8 fields per entity)",
    ["N", "payload JSON", "store", "+ read", "+ watch", "per entity"],
    rows
  );
  const [[n1, a], , [n2, b]] = series;
  note(
    `  Marginal cost per entity (N = ${count(n1)} → ${count(n2)}): store ${perItem(b[0] - a[0], n2 - n1)}, ` +
      `root read memo ${perItem(b[1] - b[0] - (a[1] - a[0]), n2 - n1)}, ` +
      `optimistic watch ${perItem(b[2] - b[1] - (a[2] - a[1]), n2 - n1)}.\n` +
      `  The watch adds a second memo set because optimistic reads never share the root's\n` +
      `  entries (performance §4.2), plus the watch's last result.`
  );
}

// ===========================================================================
// 2. Retained footprint by data shape
// ===========================================================================

if (
  section("Retained footprint by data shape: store after write, then + read")
) {
  const shapes = [
    [
      "normalized list (2 000 entities)",
      WIDE,
      () => wideData(2000),
      () => wideData(20),
    ],
    [
      "embedded list (2 000 objects)",
      WIDE_UNTYPED,
      () => wideUntypedData(2000),
      () => wideUntypedData(20),
    ],
    [
      "deep chain (D = 256)",
      deepQuery(256),
      () => deepData(256),
      () => deepData(256),
    ],
    [
      "nested lists (50 groups x 40 rows)",
      MATRIX,
      () => matrixData(50, 40),
      () => matrixData(2, 2),
    ],
    [
      "scalar matrix (100 x 1 000 strings)",
      SCALAR_MATRIX,
      () => scalarMatrixData(100, 1000),
      () => scalarMatrixData(2, 2),
    ],
    [
      "JSON blob field (5 000 objects)",
      BLOB,
      () => blobData(5000),
      () => blobData(5),
    ],
    [
      "argument-heavy field (2 000 items)",
      ARGS,
      () => argsData(2000),
      () => argsData(20),
      ARGS_VARIABLES,
    ],
  ];
  const rows = [];
  for (const [name, query, data, small, variables] of shapes) {
    const stages = (make) => [
      {
        name: "store after write",
        run: (s) => {
          s.cache = new InMemoryCache();
          s.cache.writeQuery({ query, data: make(), variables });
        },
      },
      {
        name: "+ read",
        run: (s) => void s.cache.readQuery({ query, variables }),
      },
    ];
    const out = await retainedStages(
      `shape ${name}`,
      stages(data),
      stages(small)
    );
    rows.push([
      name,
      fmtBytes(JSON.stringify(data()).length),
      fmtBytes(out[0].value),
      fmtBytes(out[1].value),
    ]);
  }
  table(
    "Retained bytes, cumulative",
    ["shape", "payload JSON", "store", "+ read"],
    rows
  );
  note(
    "  The scalar matrix is stored by reference in production (performance §7.5), so its\n" +
      "  store is the caller's arrays; the read then copies every array."
  );
}

// ===========================================================================
// 3. Allocation per operation
// ===========================================================================

if (section("Allocation per operation (N = 5 000 unless stated)")) {
  const N = 5000;
  const written = (n = N) => {
    const cache = new InMemoryCache();
    writeWide(cache, n);
    return cache;
  };
  const changedCopy = (n = N) => {
    const data = wideData(n);
    data.feed[0].f0 = "changed";
    return data;
  };
  const rows = [];
  const measure = (label, spec) => {
    const r = allocated(label, spec);
    rows.push([
      label,
      fmtBytes(r.value),
      String(r.detail.gcCount ?? "-"),
      fmtBytes(r.detail.jsPeakAboveStart ?? 0),
    ]);
  };

  measure(`write cold N=${N}`, {
    setup: () => ({ cache: new InMemoryCache(), data: wideData(N) }),
    run: (s) => s.cache.writeQuery({ query: WIDE, data: s.data }),
  });
  measure("write cold N=20000", {
    setup: () => ({ cache: new InMemoryCache(), data: wideData(20000) }),
    run: (s) => s.cache.writeQuery({ query: WIDE, data: s.data }),
  });
  measure(`write identical N=${N}`, {
    setup: () => ({ cache: written(), data: wideData(N) }),
    run: (s) => s.cache.writeQuery({ query: WIDE, data: s.data }),
  });
  measure(`write 1-changed N=${N}`, {
    setup: () => ({ cache: written(), data: changedCopy() }),
    run: (s) => s.cache.writeQuery({ query: WIDE, data: s.data }),
  });
  measure(`read cold N=${N}`, {
    setup: () => ({ cache: written() }),
    run: (s) => s.cache.readQuery({ query: WIDE }),
  });
  measure(`read warm N=${N}`, {
    setup: () => {
      const cache = written();
      cache.readQuery({ query: WIDE });
      return { cache };
    },
    run: (s) => s.cache.readQuery({ query: WIDE }),
  });
  measure(`read after 1 dirty N=${N}`, {
    setup: () => {
      const cache = written();
      cache.readQuery({ query: WIDE });
      cache.writeFragment({
        id: "Item:i0",
        fragment: ITEM_F0,
        data: { f0: "changed" },
      });
      return { cache };
    },
    run: (s) => s.cache.readQuery({ query: WIDE }),
  });
  measure(`broadcast to 50 watches after a 1-changed write N=${N}`, {
    setup: () => {
      const cache = written();
      const unwatch = Array.from({ length: 50 }, () =>
        cache.watch({
          query: WIDE,
          optimistic: true,
          immediate: true,
          callback: () => {},
        })
      );
      return {
        cache,
        data: changedCopy(),
        dispose: () => unwatch.forEach((u) => u()),
      };
    },
    run: (s) => s.cache.writeQuery({ query: WIDE, data: s.data }),
  });
  measure(`100 single-field writes in one batch, 1 watch, N=${N}`, {
    setup: () => {
      const cache = written();
      const unwatch = cache.watch({
        query: WIDE,
        optimistic: true,
        immediate: true,
        callback: noop,
      });
      return { cache, dispose: unwatch };
    },
    run: (s) =>
      s.cache.batch({
        update(c) {
          for (let k = 0; k < 100; k++) {
            c.writeFragment({
              id: `Item:i${k}`,
              fragment: ITEM_F0,
              data: { f0: `batch-${k}` },
            });
          }
        },
      }),
  });
  table(
    "Bytes allocated (JS heap + WASM heap), median of repetitions",
    ["operation", "allocated", "GCs", "JS peak ≥"],
    rows
  );
  note(
    "  'JS peak ≥' is the highest JS heap seen during the operation above its start,\n" +
      "  sampled at each collection and at the end: a lower bound on the true peak."
  );
}

// ===========================================================================
// 4. Watches, documents and optimistic layers
// ===========================================================================

if (
  section(
    "Retained by watches, distinct documents and optimistic layers (2 000 entities)"
  )
) {
  const N = 2000;
  const base = (n, watches) => ({
    name: watches ? "store + read + 1 watch" : "store + read",
    run: (s) => {
      s.cache = new InMemoryCache();
      writeWide(s.cache, n);
      s.cache.readQuery({ query: WIDE });
      s.unwatch = [];
      s.dispose = () => s.unwatch.forEach((u) => u());
      if (watches) {
        s.unwatch.push(
          s.cache.watch({
            query: WIDE,
            optimistic: true,
            immediate: true,
            callback: noop,
          })
        );
      }
    },
  });
  const watchStages = (n, watchCount, docCount) => [
    base(n, false),
    {
      name: `+ ${watchCount} watches of one document`,
      run: (s) => {
        for (let i = 0; i < watchCount; i++) {
          s.unwatch.push(
            s.cache.watch({
              query: WIDE,
              optimistic: true,
              immediate: true,
              callback: () => {},
            })
          );
        }
      },
    },
    {
      name: `+ ${docCount} watches of distinct documents`,
      run: (s) => {
        for (let i = 0; i < docCount; i++) {
          s.unwatch.push(
            s.cache.watch({
              query: distinctDocument(i),
              optimistic: true,
              immediate: true,
              callback: noop,
            })
          );
        }
      },
    },
  ];
  const layerStages = (n, layerCount) => [
    base(n, true),
    {
      name: `+ ${layerCount} optimistic layers`,
      run: (s) => {
        for (let k = 0; k < layerCount; k++) {
          s.cache.recordOptimisticTransaction((c) => {
            c.writeFragment({
              id: `Item:i${k}`,
              fragment: ITEM_F0,
              data: { f0: `optimistic-${k}` },
            });
          }, `layer-${k}`);
        }
      },
    },
    {
      name: `after removing the ${layerCount} layers`,
      run: (s) => {
        for (let k = 0; k < layerCount; k++)
          s.cache.removeOptimistic(`layer-${k}`);
      },
    },
  ];
  const watched = await retainedStages(
    `watches N=${N}`,
    watchStages(N, 200, 50),
    watchStages(20, 2, 2)
  );
  const layered = await retainedStages(
    `layers N=${N}`,
    layerStages(N, 16),
    layerStages(20, 2)
  );
  const increments = (out) =>
    out.map((o, i) => [
      o.name,
      fmtBytes(o.value),
      i ? fmtBytes(o.value - out[i - 1].value) : "-",
    ]);
  table(
    "Retained bytes, cumulative, and each stage's increment",
    ["stage", "retained", "increment"],
    [...increments(watched), ...increments(layered)]
  );
  note(
    "  Watches of one document share the memo; each distinct document builds its own\n" +
      "  (performance §4.5), up to the memo's LRU limits."
  );
  const [beforeLayers, , afterRemoval] = layered.map((o) => o.value);
  const tolerance = Math.max(128 * 1024, 0.02 * beforeLayers);
  check(
    "removing every optimistic layer returns the memory the layers took",
    afterRemoval - beforeLayers <= tolerance,
    `after removal ${fmtBytes(afterRemoval)} vs ${fmtBytes(beforeLayers)} before the layers (tolerance ${fmtBytes(tolerance)})`
  );
}

// ===========================================================================
// 5. Steady workloads must plateau
// ===========================================================================

if (section("Steady workloads: memory must plateau, not grow")) {
  const CYCLES = QUICK ? 120 : 300;
  const LIVE_PAGES = 5;
  const PAGE_SIZE = 100;

  /**
   * Runs `cycles` steps of a workload, settling every `every` steps, and returns
   * the retained bytes at each checkpoint (relative to before the workload).
   */
  async function plateau(label, { setup, step, cycles, every }) {
    if (AGGREGATE) return { final: record(label).value, points: [] };
    const warm = hold(setup);
    for (let i = 0; i < Math.min(cycles, 20); i++) use(warm, (s) => step(s, i));
    use(warm, (s) => s.dispose?.());
    drop(warm);
    await settle();
    const base = snapshot();
    const id = hold(setup);
    const points = [];
    for (let i = 0; i < cycles; i++) {
      use(id, (s) => step(s, i));
      if ((i + 1) % every === 0) {
        await settle();
        points.push([i + 1, footprint(base, snapshot()).total]);
      }
    }
    use(id, (s) => s.dispose?.());
    drop(id);
    const final = points.at(-1)[1];
    record(label, final, { points });
    return { final, points };
  }

  /** Growth over the second half of the run, projected from its least-squares slope. */
  function growthCheck(label, { final, points }, cycles) {
    if (AGGREGATE) return check(label);
    const half = points.filter(([c]) => c > cycles / 2);
    const perCycle = slope(
      half.map(([c]) => c),
      half.map(([, v]) => v)
    );
    const growth = perCycle * (cycles / 2);
    const tolerance = Math.max(256 * 1024, 0.1 * final);
    return check(
      label,
      growth <= tolerance,
      `second-half growth ${fmtBytes(growth)} (${fmtBytes(perCycle)} per cycle), tolerance ${fmtBytes(tolerance)}, final ${fmtBytes(final)}`
    );
  }

  const rows = [];
  const run = async (label, checkLabel, spec) => {
    const r = await plateau(label, spec);
    const passed = growthCheck(checkLabel, r, spec.cycles);
    rows.push([label, fmtBytes(r.final), passed ? "plateaus" : "GROWS"]);
  };

  await run(
    `rolling window: ${LIVE_PAGES} live pages of ${PAGE_SIZE}, write + read + evict + gc per page`,
    "rolling window: retained memory plateaus",
    {
      cycles: CYCLES,
      every: 10,
      setup: () => ({ cache: new InMemoryCache() }),
      step: (s, i) => {
        s.cache.writeQuery({
          query: PAGE,
          variables: { page: i },
          data: pageData(i, PAGE_SIZE),
        });
        s.cache.readQuery({ query: PAGE, variables: { page: i } });
        if (i >= LIVE_PAGES) {
          s.cache.evict({ fieldName: "feed", args: { page: i - LIVE_PAGES } });
          s.cache.gc();
        }
      },
    }
  );
  await run(
    "watch churn: subscribe + unsubscribe over 1 000 entities",
    "watch churn: retained memory plateaus",
    {
      cycles: CYCLES * 5,
      every: 50,
      setup: () => {
        const cache = new InMemoryCache();
        writeWide(cache, 1000);
        return { cache };
      },
      step: (s) => {
        const unwatch = s.cache.watch({
          query: WIDE,
          optimistic: true,
          immediate: true,
          callback: () => {},
        });
        unwatch();
      },
    }
  );
  await run(
    "optimistic churn: add + remove a layer over 1 000 entities",
    "optimistic churn: retained memory plateaus",
    {
      cycles: CYCLES * 2,
      every: 20,
      setup: () => {
        const cache = new InMemoryCache();
        writeWide(cache, 1000);
        const unwatch = cache.watch({
          query: WIDE,
          optimistic: true,
          immediate: true,
          callback: noop,
        });
        return { cache, dispose: unwatch };
      },
      step: (s, i) => {
        s.cache.recordOptimisticTransaction((c) => {
          c.writeFragment({
            id: `Item:i${i % 1000}`,
            fragment: ITEM_F0,
            data: { f0: `opt-${i}` },
          });
        }, `churn-${i}`);
        s.cache.removeOptimistic(`churn-${i}`);
      },
    }
  );
  await run(
    "document churn: a freshly parsed document per read over 1 000 entities",
    "document churn: retained memory plateaus",
    {
      cycles: CYCLES * 2,
      every: 20,
      setup: () => {
        const cache = new InMemoryCache();
        writeWide(cache, 1000);
        return { cache };
      },
      step: (s, i) => void s.cache.readQuery({ query: distinctDocument(i) }),
    }
  );
  table(
    "Retained at the end of each workload",
    ["workload", "retained", "trend"],
    rows
  );
  note(
    "  A workload plateaus when its retained memory stops growing: the check projects the\n" +
      "  least-squares slope of the second half over that half, and allows 10 % of the final\n" +
      "  value or 256 KiB. Bounded caches that fill up slowly (Apollo's memo LRUs) can grow\n" +
      "  for longer than the run; the checkpoints in --json show the curve."
  );
}

// ===========================================================================
// 6. Reclamation
// ===========================================================================

if (section("Reclamation: evict + gc, dropping a cache, reusing WASM memory")) {
  const N = 5000;
  const build = (n) => [
    {
      name: "store + read + watch",
      run: (s) => {
        s.cache = new InMemoryCache();
        writeWide(s.cache, n);
        s.cache.readQuery({ query: WIDE });
        s.unwatch = s.cache.watch({
          query: WIDE,
          optimistic: true,
          immediate: true,
          callback: noop,
        });
      },
    },
    {
      name: "after unwatch + evict + gc",
      run: (s) => {
        s.unwatch();
        s.cache.evict({ fieldName: "feed" });
        s.cache.gc();
      },
    },
  ];
  const out = await retainedStages(`reclaim N=${N}`, build(N), build(50));
  const [full, evicted] = out;
  check(
    "evict + gc returns the memory of an evicted list",
    evicted.value <= Math.max(256 * 1024, 0.05 * full.value),
    `${fmtBytes(evicted.value)} left of ${fmtBytes(full.value)}`
  );

  // Dropping the cache: everything it held must come back, JS and WASM alike.
  if (AGGREGATE) {
    check("dropping a cache returns its JS heap");
    check("dropping a cache returns its WASM heap");
    check("a second cache reuses WASM linear memory instead of growing it");
  } else {
    await settle();
    const base = snapshot();
    const first = hold(() => ({}));
    use(first, build(N)[0].run);
    use(first, (s) => s.unwatch());
    drop(first);
    await settle();
    const afterDrop = footprint(base, snapshot());
    check(
      "dropping a cache returns its JS heap",
      afterDrop.jsHeap <= 256 * 1024,
      `JS heap ${fmtBytes(afterDrop.jsHeap)} above the pre-cache baseline`
    );
    check(
      "dropping a cache returns its WASM heap",
      (afterDrop.wasmInUse ?? 0) <= 64 * 1024,
      wasmHeap ?
        `WASM heap in use ${afterDrop.wasmInUse == null ? "not reported by this build" : fmtBytes(afterDrop.wasmInUse)} above the baseline`
      : "no WASM heap (InMemoryCache)"
    );
    const highWater = wasmHeap?.read().linearBytes ?? 0;
    const second = hold(() => ({}));
    use(second, build(N)[0].run);
    use(second, (s) => s.unwatch());
    drop(second);
    await settle();
    const grown = (wasmHeap?.read().linearBytes ?? 0) - highWater;
    check(
      "a second cache reuses WASM linear memory instead of growing it",
      grown <= 64 * 1024,
      wasmHeap ?
        `linear memory ${fmtBytes(highWater)} after the first cache, grew ${fmtBytes(grown)} for the second`
      : "no WASM heap (InMemoryCache)"
    );
  }
  table(
    "Retained bytes",
    ["stage", "retained"],
    out.map((o) => [o.name, fmtBytes(o.value)])
  );
}

// ===========================================================================
// Summary and output
// ===========================================================================

if (!JSON_OUT && checks.length) {
  console.log(`\n${"=".repeat(86)}\nChecks\n${"=".repeat(86)}`);
  for (const c of checks) {
    console.log(
      `  [${c.pass ? "PASS" : "FAIL"}] ${c.label}${c.detail ? `\n         ${c.detail}` : ""}`
    );
  }
}

if (JSON_OUT) {
  const payload = {
    meta: {
      probe: "memory",
      cache: cacheName,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      quick: QUICK,
      repsPerMeasurement: REPS,
      runs: AGGREGATE?.runCount ?? 1,
      wasm: wasmHeap?.read() ?? null,
    },
    results:
      AGGREGATE ?
        [...AGGREGATE.results].map(([label, a]) => ({
          label,
          unit: UNIT,
          ...a,
        }))
      : results,
    checks,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (JSON_FILE) writeFileSync(JSON_FILE, text);
  else process.stdout.write(text);
}
