/**
 * The cache class a probe runs against, chosen by `--cache=`:
 *
 *   --cache=apollo  Apollo Client's `InMemoryCache` (default)
 *   --cache=rs      this repository's `InMemoryCacheRs`, loaded from the built
 *                   `dist/` (`npm run build:ts`) with its WASM initialized
 *
 * Exported as `InMemoryCache` so the probes read the same against either cache.
 */
import { existsSync, readFileSync } from "node:fs";

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

/** Loads `InMemoryCacheRs` the way a Node consumer of the web build must. */
async function loadInMemoryCacheRs() {
  const pkg = new URL("../../pkg/", import.meta.url);
  const { initSync } = await import(new URL("fast_gql_cache_rs.js", pkg).href);
  initSync({ module: readFileSync(new URL("fast_gql_cache_rs_bg.wasm", pkg)) });
  const dist = new URL("../../dist/index.js", import.meta.url);
  if (!existsSync(dist)) {
    console.error(
      "InMemoryCacheRs is not built: run `npm run build:ts` first."
    );
    process.exit(2);
  }
  const { InMemoryCacheRs } = await import(dist.href);
  return InMemoryCacheRs;
}

export const InMemoryCache =
  cacheName === "rs" ? await loadInMemoryCacheRs() : ApolloInMemoryCache;

// On stderr so the probes' stdout stays byte-comparable across caches.
console.error(`cache under test: ${InMemoryCache.name}`);
