/**
 * The cache class a probe runs against, chosen by `--cache=`:
 *
 *   --cache=apollo  Apollo Client's `InMemoryCache` (default)
 *   --cache=rs      this repository's `InMemoryCacheRs`, loaded from the built
 *                   `dist/` (`npm run build:ts`) with its WASM initialized
 *
 * `FAST_GQL_CACHE_RS_ROOT` loads `InMemoryCacheRs` from another checkout's `dist/`
 * and `pkg/` instead (the benchmark measures a PR's base and head builds with one
 * probe). An environment variable, so the probes' own child processes inherit it.
 *
 * Exported as `InMemoryCache` so the probes read the same against either cache.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { InMemoryCache as ApolloInMemoryCache } from "@apollo/client/cache";

const CACHES = ["apollo", "rs"];

export const cacheName = (() => {
  const arg = process.argv.find((a) => a.startsWith("--cache="));
  const name = arg ? arg.slice("--cache=".length) : "apollo";
  if (!CACHES.includes(name)) {
    console.error(
      `Unknown --cache=${name}; use ${CACHES.map((c) => `--cache=${c}`).join(" or ")}`
    );
    process.exit(2);
  }
  return name;
})();

const rsRoot =
  process.env.FAST_GQL_CACHE_RS_ROOT ?
    pathToFileURL(`${process.env.FAST_GQL_CACHE_RS_ROOT.replace(/\/$/, "")}/`)
  : new URL("../../", import.meta.url);

/**
 * Reads the WASM heap of the cache under test, for the memory probe: `null` for
 * Apollo's cache. `linearBytes` is the size of the linear memory, which only
 * grows. `inUse`, `peak` and `allocatedTotal` come from the counting allocator
 * (`wasm/src/heap_stats.rs`) and are `null` for a build that predates it, such
 * as the base of a benchmark.
 */
export let wasmHeap = null;

/** Loads `InMemoryCacheRs` the way a Node consumer of the web build must. */
async function loadInMemoryCacheRs() {
  const wasm = new URL("pkg/fast_gql_cache_rs_bg.wasm", rsRoot);
  const dist = new URL("dist/index.js", rsRoot);
  if (!existsSync(wasm) || !existsSync(dist)) {
    console.error(
      "InMemoryCacheRs is not built: run `npm run build:ts` first " +
        "(and `npm run wasm:build` if pkg/ is missing)."
    );
    process.exit(2);
  }
  const glue = await import(new URL("pkg/fast_gql_cache_rs.js", rsRoot).href);
  const exports = glue.initSync({ module: readFileSync(wasm) });
  const counter = (name) =>
    typeof glue[name] === "function" ? () => glue[name]() : () => null;
  const inUse = counter("wasm_heap_in_use");
  const peak = counter("wasm_heap_peak");
  const allocatedTotal = counter("wasm_heap_allocated_total");
  wasmHeap = {
    read: () => ({
      linearBytes: exports.memory.buffer.byteLength,
      inUse: inUse(),
      peak: peak(),
      allocatedTotal: allocatedTotal(),
    }),
    resetPeak: () => glue.wasm_heap_reset_peak?.(),
  };
  const { InMemoryCacheRs } = await import(dist.href);
  return InMemoryCacheRs;
}

export const InMemoryCache =
  cacheName === "rs" ? await loadInMemoryCacheRs() : ApolloInMemoryCache;

// On stderr so the probes' stdout stays byte-comparable across caches.
console.error(
  cacheName === "rs" ?
    `cache under test: InMemoryCacheRs from ${decodeURIComponent(rsRoot.pathname).replace(/\/$/, "")}`
  : `cache under test: ${InMemoryCache.name}`
);
