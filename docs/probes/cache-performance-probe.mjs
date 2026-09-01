/**
 * Executable performance probe for Apollo Client's `InMemoryCache` (v4.2.11).
 *
 * Companion to `docs/apollo-client-inmemory-cache-performance.md`: every cost
 * claim in that document is produced by this file. Re-run it to re-derive the
 * numbers on a new machine or a new Apollo version.
 *
 *   node --expose-gc docs/probes/cache-performance-probe.mjs
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --quick
 *   node --expose-gc docs/probes/cache-performance-probe.mjs --json > results.json
 *
 * Deliberately NOT run with `--conditions=development`: the development build
 * deep-freezes every read result (`maybeDeepFreeze`) and runs
 * `warnAboutDataLoss` on every write, neither of which ships to production. The
 * last measured section quantifies that overhead by re-invoking this file in a
 * child process with the development condition.
 *
 * Method
 * ------
 * Each measurement runs `setup` (untimed) then `run` (timed) `reps` times and
 * reports the MEDIAN, which is far more robust than the mean against GC pauses
 * and JIT tiering. Scaling columns divide adjacent medians so the growth rate
 * is visible without a curve fit.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { InMemoryCache } from "@apollo/client/cache";
import { gql } from "graphql-tag";

const QUICK = process.argv.includes("--quick");
const JSON_OUT = process.argv.includes("--json");
const IS_CHILD = process.argv.includes("--child-dev");
const results = [];

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
function bench(label, { setup, run, reps = QUICK ? 7 : 25, warmup = 3 }) {
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
  if (IS_CHILD) return false;
  if (!JSON_OUT) {
    console.log(
      `\n${"=".repeat(86)}\n${++sectionNo}. ${title}\n${"=".repeat(86)}`
    );
  }
  return true;
}

function note(text) {
  if (!JSON_OUT) console.log(`\n${text}`);
}

/**
 * Prints a scaling table. `rows` is [[sizeLabel, size, {col: ns}], ...].
 * Adds a "x" column per measurement showing growth against the previous row,
 * and a "x/n" column showing growth normalised by the size ratio (1.00 = linear).
 */
function table(title, columns, rows) {
  if (JSON_OUT) return;
  console.log(`\n  ${title}`);
  const head = ["n".padStart(8)];
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
        cells.push(`${(growth / sizeRatio).toFixed(2)}n`.padStart(8));
      } else {
        cells.push("-".padStart(8));
      }
    }
    console.log(`  ${cells.join(" ")}`);
    prev = values;
    prevSize = size;
  }
  console.log(
    `  (scale = growth factor divided by the size ratio: 1.00n = linear, 2.00n = quadratic)`
  );
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

/** A single chain of `depth` normalizable entities: node -> child -> child ... */
function deepNormalized(depth, fields = 3) {
  const scalarFields = Array.from({ length: fields }, (_, i) => `f${i}`);
  let selection = `__typename\n        id\n        ${scalarFields.join("\n        ")}`;
  for (let d = 0; d < depth; d++) {
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
    if (d < depth) node.child = build(d + 1);
    return node;
  };
  return { query, data: { root: build(0) } };
}

/** The same chain, but with no `id` fields, so the whole tree stays embedded. */
function deepUntyped(depth, fields = 3) {
  const scalarFields = Array.from({ length: fields }, (_, i) => `f${i}`);
  let selection = `__typename\n        ${scalarFields.join("\n        ")}`;
  for (let d = 0; d < depth; d++) {
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
    if (d < depth) node.child = build(d + 1);
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
    const cold = bench(`write cold n=${n}`, {
      setup: () => freshCache(),
      run: (cache) => cache.writeQuery({ query: shape.query, data: shape.data }),
    });
    const identical = bench(`write identical n=${n}`, {
      setup: () => written(shape),
      run: (cache) => cache.writeQuery({ query: shape.query, data: shape.data }),
    });
    const oneChanged = (() => {
      const changed = {
        feed: shape.data.feed.map((item, i) =>
          i === 0 ? { ...item, f0: "CHANGED" } : item
        ),
      };
      return bench(`write 1-changed n=${n}`, {
        setup: () => written(shape),
        run: (cache) => cache.writeQuery({ query: shape.query, data: changed }),
      });
    })();
    rows.push([n, n, { cold, identical, "1 changed": oneChanged }]);
  }
  table(
    "writeQuery into a list of n normalized entities",
    ["cold", "identical", "1 changed"],
    rows
  );
  note(
    `  Reading: "identical" still pays the full traversal + normalization + deep\n` +
      `  equality; it only avoids dirtying fields. There is no early-out for an\n` +
      `  unchanged payload, because the writer cannot know it is unchanged until it\n` +
      `  has normalized it.`
  );
}

// ===========================================================================
if (section("Read cost vs. list breadth: cold, warm, and after one dirty field")) {
  const sizes = QUICK ? [100, 1000] : [100, 1000, 5000, 20000];
  const rows = [];
  for (const n of sizes) {
    const shape = wideNormalized(n);

    const cold = bench(`read cold n=${n}`, {
      setup: () => {
        const cache = written(shape);
        cache.gc({ resetResultCache: true });
        return cache;
      },
      run: (cache) => cache.readQuery({ query: shape.query }),
    });

    const warmCache = written(shape);
    warmCache.readQuery({ query: shape.query });
    const warm = bench(`read warm n=${n}`, {
      run: () => warmCache.readQuery({ query: shape.query }),
    });

    const afterDirty = bench(`read after 1 dirty n=${n}`, {
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
    "readQuery over a list of n normalized entities",
    ["cold", "warm", "after 1 dirty"],
    rows
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
    return `    n=${String(n).padStart(5)}  executeSelectionSet=${String(m.selectionSets).padStart(6)}  executeSubSelectedArray=${m.arrays}`;
  });
  note(
    `  Memo entries retained by a single read (bounded by cacheSizes limits\n` +
      `  50 000 / 10 000 respectively):\n${memoRows.join("\n")}`
  );
}

// ===========================================================================
if (section("Normalized vs. embedded (untyped) payloads of the same size")) {
  const sizes = QUICK ? [100, 1000] : [100, 1000, 5000];
  const rows = [];
  for (const n of sizes) {
    const norm = wideNormalized(n);
    const untyped = wideUntyped(n);

    const wNorm = bench(`write normalized n=${n}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: norm.query, data: norm.data }),
    });
    const wUntyped = bench(`write untyped n=${n}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: untyped.query, data: untyped.data }),
    });

    const normWarm = written(norm);
    normWarm.readQuery({ query: norm.query });
    const rNorm = bench(`read warm normalized n=${n}`, {
      run: () => normWarm.readQuery({ query: norm.query }),
    });

    const untypedWarm = written(untyped);
    untypedWarm.readQuery({ query: untyped.query });
    const rUntyped = bench(`read warm untyped n=${n}`, {
      run: () => untypedWarm.readQuery({ query: untyped.query }),
    });

    rows.push([
      n,
      n,
      {
        "write norm": wNorm,
        "write embed": wUntyped,
        "read norm": rNorm,
        "read embed": rUntyped,
      },
    ]);
  }
  table(
    "n entities, 6 scalar fields each",
    ["write norm", "write embed", "read norm", "read embed"],
    rows
  );

  const n = QUICK ? 200 : 2000;
  const norm = written(wideNormalized(n));
  const untyped = written(wideUntyped(n));
  note(
    `  Store entry counts for n=${n}:\n` +
      `    normalized: ${Object.keys(norm.extract()).length} entries (1 root + n entities)\n` +
      `    embedded:   ${Object.keys(untyped.extract()).length} entries (root only — the whole list lives in one field)`
  );
  note(
    `  Embedded payloads write faster (no identify, no reference indirection) and\n` +
      `  read faster warm, but they are a single cache field: changing one element\n` +
      `  dirties the entire list, and nothing is shared with any other query.`
  );
}

// ===========================================================================
if (section("Depth: cost per level of nesting")) {
  const depths = QUICK ? [4, 16] : [4, 16, 64, 128];
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
        c.modify({ id: `Node:n${d}`, fields: { f0: (v) => `${v}!` } });
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
    "a single chain of d nested entities",
    ["write norm", "write embed", "read cold", "read warm", "deep dirty"],
    rows
  );
  note(
    `  "deep dirty" is the headline number: modifying the LEAF of a d-deep chain\n` +
      `  invalidates every ancestor memo entry, so the re-read costs the same as a\n` +
      `  cold read of the whole chain. Depth converts a point mutation into a\n` +
      `  root-to-leaf recomputation. Breadth does not — see section 2.`
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
    "outer groups each holding inner normalized rows",
    ["write", "read cold", "read warm", "1 row dirty"],
    rows
  );

  const scalarConfigs = QUICK ? [[10, 100]] : [
    [10, 100],
    [100, 100],
    [100, 1000],
  ];
  const scalarRows = [];
  for (const [outer, inner] of scalarConfigs) {
    const shape = scalarMatrix(outer, inner);
    const w = bench(`write scalar matrix ${outer}x${inner}`, {
      setup: () => freshCache(),
      run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
    });
    const warm = written(shape);
    warm.readQuery({ query: shape.query });
    const rw = bench(`read warm scalar matrix ${outer}x${inner}`, {
      run: () => warm.readQuery({ query: shape.query }),
    });
    scalarRows.push([
      `${outer}x${inner}`,
      outer * inner,
      { write: w, "read warm": rw },
    ]);
  }
  table(
    "arrays of arrays of plain scalars (no entities, no selection set)",
    ["write", "read warm"],
    scalarRows
  );
  note(
    `  A scalar array without a sub-selection is stored and returned as ONE field\n` +
      `  value. It costs a deep-equality pass on write and nothing on read, but it is\n` +
      `  also atomic: any change replaces the whole array.`
  );
}

// ===========================================================================
if (section("Broadcast cost vs. number of watchers")) {
  const shape = wideNormalized(QUICK ? 200 : 2000);
  const watcherCounts = QUICK ? [1, 25] : [1, 10, 50, 200];
  const rows = [];
  for (const w of watcherCounts) {
    const changed = {
      feed: shape.data.feed.map((item, i) =>
        i === 0 ? { ...item, f0: "CHANGED" } : item
      ),
    };

    const setup = () => {
      const cache = written(shape);
      let calls = 0;
      for (let i = 0; i < w; i++) {
        cache.watch({
          query: shape.query,
          optimistic: true,
          callback: () => calls++,
        });
      }
      // Warm BOTH memo sets. Watches read with optimistic: true, which goes
      // through the Stump's CacheGroup and therefore its own keyMaker Trie —
      // warming only the root read would make every rep pay a cold optimistic
      // read and swamp the fan-out signal we are trying to measure.
      cache.readQuery({ query: shape.query });
      cache.diff({ query: shape.query, optimistic: true, returnPartialData: true });
      return { cache, changed, stats: () => calls };
    };

    const relevant = bench(`broadcast ${w} watchers, relevant write`, {
      setup,
      run: ({ cache }) =>
        cache.writeQuery({ query: shape.query, data: changed }),
    });

    const irrelevant = bench(`broadcast ${w} watchers, unrelated write`, {
      setup,
      run: ({ cache }) =>
        cache.writeQuery({
          query: gql`
            query Other {
              unrelated {
                __typename
                id
                v
              }
            }
          `,
          data: { unrelated: { __typename: "Other", id: "o1", v: 1 } },
        }),
    });

    rows.push([w, w, { relevant: relevant, unrelated: irrelevant }]);
  }
  table(
    "one write with w watchers registered on the same query",
    ["relevant", "unrelated"],
    rows
  );
  note(
    `  "unrelated" is the equality-gate path: the watches are not dirty, so\n` +
      `  maybeBroadcastWatch returns its memoized value and no diff is recomputed.\n` +
      `  That is the difference between O(w) cheap checks and O(w) full re-reads.`
  );

  // Identical-watch sharing: N watchers on the SAME query+variables share
  // StoreReader memo entries, so the marginal cost per watcher is small. The
  // "distinct" documents below select exactly the same fields and differ only
  // by operation name, so any difference is document identity, not workload.
  const distinctShape = (i) => ({
    query: gql`
      query Distinct${i} {
        feed {
          __typename
          id
          ${shape.scalarFields.join("\n          ")}
        }
      }
    `,
  });
  const same = bench("broadcast 50 identical watches", {
    setup: () => {
      const cache = written(shape);
      for (let i = 0; i < 50; i++) {
        cache.watch({ query: shape.query, optimistic: true, callback() {} });
      }
      cache.diff({ query: shape.query, optimistic: true, returnPartialData: true });
      return cache;
    },
    run: (cache) =>
      cache.writeQuery({
        query: shape.query,
        data: {
          feed: shape.data.feed.map((it, i) =>
            i === 0 ? { ...it, f0: `x${Math.random()}` } : it
          ),
        },
      }),
  });
  const distinct = bench("broadcast 50 distinct-document watches", {
    setup: () => {
      const cache = written(shape);
      for (let i = 0; i < 50; i++) {
        const q = distinctShape(i).query;
        cache.watch({ query: q, optimistic: true, callback() {} });
        cache.diff({ query: q, optimistic: true, returnPartialData: true });
      }
      return cache;
    },
    run: (cache) =>
      cache.writeQuery({
        query: shape.query,
        data: {
          feed: shape.data.feed.map((it, i) =>
            i === 0 ? { ...it, f0: `x${Math.random()}` } : it
          ),
        },
      }),
  });
  note(
    `  50 watchers on the SAME document:      ${fmt(same)}\n` +
      `  50 watchers on 50 DISTINCT documents:  ${fmt(distinct)}\n` +
      `  Ratio: ${(distinct / same).toFixed(1)}x. Memo entries are keyed by selection-set\n` +
      `  NODE identity, so structurally identical but separately-parsed documents\n` +
      `  share nothing. This is why DocumentTransform's WeakCache matters.`
  );
}

// ===========================================================================
if (section("Transactions, optimistic layers, and layer depth")) {
  const shape = wideNormalized(QUICK ? 200 : 2000);
  const layerCounts = QUICK ? [1, 4] : [1, 4, 16, 64];
  const rows = [];
  for (const layers of layerCounts) {
    const addRemove = bench(`add+remove ${layers} layers`, {
      setup: () => written(shape),
      run: (cache) => {
        for (let i = 0; i < layers; i++) {
          cache.recordOptimisticTransaction((c) => {
            c.writeQuery({
              query: shape.query,
              data: {
                feed: [{ ...shape.data.feed[0], f0: `opt${i}` }],
              },
            });
          }, `layer-${i}`);
        }
        for (let i = 0; i < layers; i++) cache.removeOptimistic(`layer-${i}`);
      },
    });

    const readThrough = bench(`optimistic read through ${layers} layers`, {
      setup: () => {
        const cache = written(shape);
        for (let i = 0; i < layers; i++) {
          cache.recordOptimisticTransaction((c) => {
            c.writeQuery({
              query: shape.query,
              data: { feed: [{ ...shape.data.feed[0], f0: `opt${i}` }] },
            });
          }, `layer-${i}`);
        }
        cache.readQuery({ query: shape.query, optimistic: true });
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
      setup: () => {
        const cache = written(shape);
        for (let i = 0; i < layers; i++) {
          cache.recordOptimisticTransaction((c) => {
            c.writeQuery({
              query: shape.query,
              data: { feed: [{ ...shape.data.feed[0], f0: `opt${i}` }] },
            });
          }, `layer-${i}`);
        }
        return cache;
      },
      run: (cache) => cache.removeOptimistic("layer-0"),
    });

    rows.push([
      layers,
      layers,
      {
        "add+remove": addRemove,
        "read through": readThrough,
        "remove bottom": removeBottom,
      },
    ]);
  }
  table(
    "k stacked optimistic layers over a 2000-entity store",
    ["add+remove", "read through", "remove bottom"],
    rows
  );
  note(
    `  "remove bottom" is the expensive one: removing a layer that is not on top\n` +
      `  replays every layer above it (EntityStore.removeLayer -> Layer.newLayer +\n` +
      `  replay), so the cost is proportional to the number of layers above it times\n` +
      `  the size of each layer's write.`
  );

  // Batching: one broadcast vs. N broadcasts.
  const writes = QUICK ? 20 : 100;
  const unbatched = bench(`${writes} separate writes (${writes} broadcasts)`, {
    setup: () => {
      const cache = written(shape);
      cache.watch({ query: shape.query, optimistic: true, callback() {} });
      cache.readQuery({ query: shape.query });
      return cache;
    },
    run: (cache) => {
      for (let i = 0; i < writes; i++) {
        cache.writeQuery({
          query: shape.query,
          data: { feed: [{ ...shape.data.feed[i], f0: `v${i}` }] },
        });
      }
    },
  });
  const batched = bench(`${writes} writes in one batch (1 broadcast)`, {
    setup: () => {
      const cache = written(shape);
      cache.watch({ query: shape.query, optimistic: true, callback() {} });
      cache.readQuery({ query: shape.query });
      return cache;
    },
    run: (cache) =>
      cache.batch({
        update: (c) => {
          for (let i = 0; i < writes; i++) {
            c.writeQuery({
              query: shape.query,
              data: { feed: [{ ...shape.data.feed[i], f0: `v${i}` }] },
            });
          }
        },
      }),
  });
  note(
    `  ${writes} writes, 1 watcher on a ${QUICK ? 200 : 2000}-entity list:\n` +
      `    unbatched: ${fmt(unbatched)}\n` +
      `    batched:   ${fmt(batched)}   (${(unbatched / batched).toFixed(1)}x faster)\n` +
      `  The saving is entirely the avoided re-reads: each broadcast recomputes the\n` +
      `  watcher's diff, and a diff over the full list is the dominant term.`
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
      `  Every watched query therefore costs TWO full sets of memo entries, because\n` +
      `  ObservableQuery always watches with optimistic: true while readQuery and\n` +
      `  readFragment default to optimistic: false. Budget memo capacity accordingly.`
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
  note(
    `  A single query whose result contains more entities than the memo can hold\n` +
      `  evicts its own entries while it reads. Every subsequent "warm" read is then\n` +
      `  a cold read, and the cliff is abrupt rather than gradual: below the limit the\n` +
      `  read is microseconds, above it milliseconds. Raise it with\n` +
      `  cacheSizes["inMemoryCache.executeSelectionSet"], or do not read that many\n` +
      `  entities in one query.`
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
    "one field with k arguments over a 50-item result",
    ["write", "read cold"],
    rows
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
    // Repeated writes with the SAME variables object hit canonicalStringify's
    // memo; a fresh (structurally equal) object each time does not.
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
    "one field whose argument is an object nested d levels deep (1-item result)",
    ["write", "fresh vars"],
    nestedRows
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
}

// ===========================================================================
if (section("keyFields: identity extraction cost")) {
  const data = {
    books: Array.from({ length: QUICK ? 200 : 2000 }, (_, i) => ({
      __typename: "Book",
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
    "keyFields: 3 flat fields": {
      typePolicies: {
        Book: { keyFields: ["isbn", "title"] },
      },
    },
    "keyFields with nested path": {
      typePolicies: {
        Book: { keyFields: ["isbn", "author", ["name"]] },
      },
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
    rows.push([label, 1, { write: w }]);
  }
  const baseline = rows[0][2].write;
  if (!JSON_OUT) {
    console.log(`\n  Book list write cost by keyFields configuration`);
    console.log(
      `  ${"config".padEnd(30)} ${"write".padStart(13)} ${"vs default".padStart(12)}`
    );
    console.log(`  ${"-".repeat(58)}`);
    for (const [label, , values] of rows) {
      console.log(
        `  ${label.padEnd(30)} ${fmt(values.write).padStart(13)} ${`${(values.write / baseline).toFixed(2)}x`.padStart(12)}`
      );
    }
  }
  note(
    `  Every normalizable object pays identify() on write. A nested keyFields path\n` +
      `  is the most expensive configuration: extractKeyPath walks into the sub-object\n` +
      `  and canonically stringifies it for every entity. Note that keyFields: false is\n` +
      `  NOT free — it removes the identify cost but turns the whole list into one\n` +
      `  embedded field value, which the writer must deep-compare on every write.`
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

    const gcNoop = bench(`gc with nothing to collect (${n})`, {
      setup: () => written(shape),
      run: (c) => c.gc(),
    });

    const gcCollect = bench(`gc after unreachable ${n}`, {
      setup: () => {
        const c = written(shape);
        // Detach the whole list from ROOT_QUERY: every Item becomes unreachable
        // but still retained by the direct write, so release them too.
        c.modify({ fields: { feed: (_, { DELETE }) => DELETE } });
        for (let i = 0; i < n; i++) c.release(`Item:i${i}`);
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

    rows.push([
      n,
      n,
      {
        "evict entity": evictOne,
        "evict field": evictField,
        "gc noop": gcNoop,
        "gc collect": gcCollect,
        extract,
        restore,
      },
    ]);
  }
  table(
    "lifecycle operations over a store of n entities",
    [
      "evict entity",
      "evict field",
      "gc noop",
      "gc collect",
      "extract",
      "restore",
    ],
    rows
  );
  note(
    `  gc() is a full mark-and-sweep: it walks every root and every reachable field\n` +
      `  of every entity, so it is O(store) EVEN WHEN IT COLLECTS NOTHING. restore()\n` +
      `  is dramatically cheaper than a write of the same data because it skips\n` +
      `  normalization entirely — the snapshot is already normalized.`
  );
}

// ===========================================================================
if (section("Result caching off: what memoization is worth")) {
  const n = QUICK ? 500 : 5000;
  const shape = wideNormalized(n);

  const withCaching = (() => {
    const c = written(shape);
    c.readQuery({ query: shape.query });
    return bench(`read warm, resultCaching on (n=${n})`, {
      run: () => c.readQuery({ query: shape.query }),
    });
  })();

  const withoutCaching = (() => {
    const c = written(shape, { resultCaching: false });
    c.readQuery({ query: shape.query });
    return bench(`read warm, resultCaching off (n=${n})`, {
      run: () => c.readQuery({ query: shape.query }),
    });
  })();

  const writeOn = bench(`write, resultCaching on (n=${n})`, {
    setup: () => freshCache(),
    run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
  });
  const writeOff = bench(`write, resultCaching off (n=${n})`, {
    setup: () => freshCache({ resultCaching: false }),
    run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
  });

  note(
    `  n=${n} entities:\n` +
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
section("Development-build overhead (maybeDeepFreeze + warnAboutDataLoss)");
// ===========================================================================
{
  const n = QUICK ? 500 : 5000;
  const shape = wideNormalized(n);

  const write = bench(`dev-overhead write n=${n}`, {
    setup: () => freshCache(),
    run: (c) => c.writeQuery({ query: shape.query, data: shape.data }),
  });
  const readCold = bench(`dev-overhead read cold n=${n}`, {
    setup: () => {
      const c = written(shape);
      c.gc({ resetResultCache: true });
      return c;
    },
    run: (c) => c.readQuery({ query: shape.query }),
  });

  if (IS_CHILD) {
    // Running under --conditions=development: report and let the parent read it.
    console.log(
      `__DEV_RESULT__ ${JSON.stringify({ n, write, readCold, frozen: isDevBuild() })}`
    );
  } else {
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--conditions=development",
        fileURLToPath(import.meta.url),
        ...(QUICK ? ["--quick"] : []),
        "--child-dev",
      ],
      { encoding: "utf8", timeout: 600_000 }
    );
    const line = (child.stdout || "")
      .split("\n")
      .find((l) => l.startsWith("__DEV_RESULT__"));
    if (line) {
      const dev = JSON.parse(line.slice("__DEV_RESULT__".length));
      note(
        `  n=${n} entities, production build vs. development build:\n` +
          `    write     prod ${fmt(write).padStart(10)}   dev ${fmt(dev.write).padStart(10)}   ${(dev.write / write).toFixed(2)}x\n` +
          `    read cold prod ${fmt(readCold).padStart(10)}   dev ${fmt(dev.readCold).padStart(10)}   ${(dev.readCold / readCold).toFixed(2)}x\n` +
          `    results frozen: prod=${isDevBuild()} dev=${dev.frozen}\n` +
          `  The development build deep-freezes every object it returns and runs\n` +
          `  warnAboutDataLoss on every write. The overhead is real but modest on this\n` +
          `  shape, because maybeDeepFreeze short-circuits on already-frozen subtrees\n` +
          `  and the reader reuses frozen memo entries. It grows with the proportion of\n` +
          `  freshly-created result objects, so it is worst on cold reads.`
      );
    } else {
      note(
        `  Could not measure development-build overhead (child exited ${child.status}).`
      );
    }
  }
}

if (IS_CHILD) process.exit(0);

// ===========================================================================
section("Summary: slowest measurements");
// ===========================================================================
if (JSON_OUT) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  const top = [...results].sort((a, b) => b.ns - a.ns).slice(0, 15);
  console.log();
  for (const { label, ns } of top) {
    console.log(`  ${fmt(ns).padStart(12)}  ${label}`);
  }
  console.log(
    `\n  ${results.length} measurements. Node ${process.version} on ${process.platform}/${process.arch}.`
  );
  console.log(
    `  Development build: ${isDevBuild()} (true = results are deep-frozen)`
  );
}
