/**
 * Measurement primitives for the memory probe (`cache-memory-probe.mjs`).
 *
 * Two quantities, measured differently:
 *
 * - **Retained bytes**: what stays alive after an operation. Measured between two
 *   settled heaps (`settle`), so only reachable objects count. The JS heap is
 *   V8's `used_heap_size`. External memory (ArrayBuffers, WASM linear memory) is
 *   counted separately, and the WASM heap is counted by the bytes its allocator
 *   has in use, not by the linear memory's size, which never shrinks.
 * - **Allocated bytes**: the churn an operation causes, whether or not it
 *   survives. JS allocation is the heap growth over the operation plus what every
 *   garbage collection during it reclaimed (from `v8.GCProfiler`, which reports
 *   each collection's before and after heap). WASM allocation is the difference
 *   of the allocator's cumulative counter.
 *
 * Requires `--expose-gc`.
 */
import v8 from "node:v8";

import { wasmHeap } from "./select-cache.mjs";

export function requireGc() {
  if (typeof globalThis.gc !== "function") {
    console.error("The memory probe needs --expose-gc.");
    process.exit(2);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Objects a measurement holds on purpose, by id. Measurement code must never keep
 * a cache in a local variable of an async function. V8 saves a suspended async
 * function's live registers into its generator object, and a slot saved at an
 * earlier `await` keeps its stale value. So a cache the code has finished with
 * stays reachable, and a leak check reads it as leaked. Conversely, a local that
 * is never read after an `await` is not saved at all, and a retained measurement
 * of it reads zero. Held objects live here instead, and code reaches them only
 * inside the synchronous callbacks of `use`.
 */
const held = new Map();
let nextId = 0;

/** Holds the value `make()` returns; returns its id. */
export function hold(make) {
  const id = nextId++;
  held.set(id, make());
  return id;
}

/** Runs `fn` with the held value, synchronously, and returns its result. */
export function use(id, fn) {
  if (!held.has(id)) throw new Error(`Nothing is held under id ${id}`);
  return fn(held.get(id));
}

export function drop(id) {
  held.delete(id);
}

/**
 * Collects garbage until the heap stops shrinking. Several rounds, because one
 * full collection can leave work for the next (weak references, finalizers,
 * objects freed by callbacks that ran in between), and `FinalizationRegistry`
 * callbacks only run on a later task.
 */
export async function settle({ rounds = 12, tolerance = 4096 } = {}) {
  let previous = Infinity;
  for (let i = 0; i < rounds; i++) {
    globalThis.gc();
    await tick();
    const used = v8.getHeapStatistics().used_heap_size;
    if (i >= 2 && Math.abs(previous - used) <= tolerance) return;
    previous = used;
  }
}

/** One reading of every memory the cache can hold. */
export function snapshot() {
  const heap = v8.getHeapStatistics();
  const usage = process.memoryUsage();
  return {
    jsHeap: heap.used_heap_size,
    external: usage.external,
    rss: usage.rss,
    wasm: wasmHeap?.read() ?? null,
  };
}

/**
 * Retained bytes between two snapshots. `total` counts the WASM heap by the
 * bytes in use when the build reports them, and by linear-memory growth when it
 * does not (a base build that predates the counting allocator).
 */
export function footprint(before, after) {
  const wasmLinear =
    before.wasm ? after.wasm.linearBytes - before.wasm.linearBytes : 0;
  const wasmInUse =
    before.wasm?.inUse != null ? after.wasm.inUse - before.wasm.inUse : null;
  const jsHeap = after.jsHeap - before.jsHeap;
  // External memory includes the WASM linear memory: count the WASM heap once.
  const externalOther = after.external - before.external - wasmLinear;
  return {
    total: jsHeap + externalOther + (wasmInUse ?? wasmLinear),
    jsHeap,
    externalOther,
    wasmInUse,
    wasmLinear,
  };
}

/**
 * Bytes allocated while `run` executes, and the garbage collections it caused.
 * Starts from a collected heap, so a collection during `run` reclaims garbage
 * that `run` made, not garbage left over from before.
 */
export function allocation(run) {
  globalThis.gc();
  const profiler = new v8.GCProfiler();
  const wasmStart = wasmHeap?.read().allocatedTotal ?? null;
  profiler.start();
  const start = v8.getHeapStatistics().used_heap_size;
  run();
  const end = v8.getHeapStatistics().used_heap_size;
  const { statistics } = profiler.stop();
  const wasmEnd = wasmHeap?.read().allocatedTotal ?? null;

  let reclaimed = 0;
  let pauseUs = 0;
  let peak = end;
  for (const gc of statistics) {
    const before = gc.beforeGC.heapStatistics.usedHeapSize;
    reclaimed += before - gc.afterGC.heapStatistics.usedHeapSize;
    pauseUs += gc.cost;
    peak = Math.max(peak, before);
  }
  const js = end - start + reclaimed;
  const wasm = wasmStart == null ? 0 : wasmEnd - wasmStart;
  return {
    total: js + wasm,
    js,
    wasm,
    gcCount: statistics.length,
    gcPauseUs: pauseUs,
    // The highest JS heap observed during `run`, above its start. A lower
    // bound: the heap is only observed at collections and at the end.
    jsPeakAboveStart: peak - start,
  };
}

/** Least-squares slope of `ys` over `xs`. */
export function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function fmtBytes(bytes) {
  const sign = bytes < 0 ? "-" : "";
  const b = Math.abs(bytes);
  if (b >= 1024 ** 3) return `${sign}${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${sign}${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${sign}${(b / 1024).toFixed(1)} KiB`;
  return `${sign}${Math.round(b)} B`;
}
