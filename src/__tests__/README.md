# Tests

These suites are Apollo Client's own `InMemoryCache` tests
(`apollo-client-sm/src/cache/`, `@apollo/client@4.2.11`), run against
`InMemoryCacheRs`. They are the compatibility oracle (the client contract and the
user-authored surface in ADR 0002, `docs/adr/`), so test bodies stay Apollo's: a port
changes imports and wiring, never assertions.

| Here | Apollo's source |
| --- | --- |
| `cache.ts` | `cache/inmemory/__tests__/cache.ts` |
| `diffAgainstStore.ts`, `entityStore.ts`, `fragmentMatcher.ts`, `fragmentRegistry.ts`, `optimistic.ts`, `policies.ts`, `readFromStore.ts`, `recordingCache.ts`, `roundtrip.ts`, `writeToStore.ts` | the same names in `cache/inmemory/__tests__/` |
| `cache.writeQuery/extensions.test.ts` | `cache/inmemory/__tests__/cache.writeQuery/extensions.test.ts` |
| `cache.watchFragment/types.test.ts` | `cache/core/__tests__/cache.watchFragment/types.test.ts` |
| `helpers.ts` | `cache/inmemory/__tests__/helpers.ts`, plus the `StoreReader`/`StoreWriter` wrappers below |

Not ported: `cache/inmemory/__tests__/key-extractor.ts` unit-tests Apollo's key-extractor
module directly, never through the cache. `cache/core/__tests__/cache.ts` tests the
abstract `ApolloCache` with a stub subclass. Port either one when Rust replaces what it
tests.

## The porting rules

1. `InMemoryCache` becomes `InMemoryCacheRs`, and `InMemoryCacheConfig` becomes
   `InMemoryCacheRsConfig`, everywhere, test names included. Both are imported from
   `src/`.
2. Relative imports into Apollo's tree are replaced:
   - by `@apollo/client/cache` or `@apollo/client/utilities` where the symbol is exported
     there, including the symbols re-exported by `patches/@apollo+client+4.2.11.patch`;
   - by the local `helpers.js` for `StoreReader`/`StoreWriter`;
   - by a direct import from `apollo-client-sm/src/` otherwise (`extractFragmentContext`,
     `defaultCacheSizes`, the `StorageType`/`KeyFieldsFunction` types).
3. `@apollo/client/testing/internal` is imported per file from the submodule
   (`disposables/spyOnConsole.js`, `ObservableStream.js`). Its index re-exports React
   render helpers (`.tsx`), which this Jest setup does not load.
4. `lodash` named imports become per-function default imports (`lodash/omit.js`). lodash
   is CommonJS, so Node's ESM loader cannot see its named exports.
5. Snapshots are written by the first run and must match Apollo's `__snapshots__` value
   for value; the snapshot names differ only by rule 1.

`helpers.ts` exports `StoreReader` and `StoreWriter` subclasses that accept an
`InMemoryCacheRs`, so suites that drive Apollo's reader and writer directly keep their
bodies. Its `defaultNormalizedCacheFactory` and `writeQueryToStore` build today's
`EntityStore`; when Rust-WASM replaces the store (ADR 0001, Phase 2), switching them to
the Rust store turns `diffAgainstStore`, `readFromStore`, `writeToStore`, `roundtrip`
and `recordingCache` into its oracle.

Apollo's custom matchers that these suites use (`toBeOneOf`, `toEmitAnything`,
`toEmitTypedValue`, `toStrictEqualTyped`) are copied into `src/testUtils/matchers/`,
because `tsconfig.json` roots at `src/`. `config/jest/setup.ts` registers Apollo's
equality testers from the submodule, as Apollo's own setup does.
