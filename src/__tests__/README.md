# Tests

These suites are Apollo Client's own `InMemoryCache` tests
(`apollo-client-sm/src/cache/`, `@apollo/client@4.2.11`), run against
`InMemoryCacheRs`. They are the compatibility oracle for tiers 1 and 2 of
[ADR 0002](../../docs/adr/0002-compatibility-target.md), so test bodies stay Apollo's: a
port changes imports and wiring, never assertions. An assertion changes only through an
entry in the [drift register](../../docs/compatibility.md#behaviour-drift), and every
changed or new test is [annotated](#annotating-a-changed-or-new-test).

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

## Annotating a changed or new test

A test that differs from Apollo's beyond rules 1–5, or that has no Apollo original, starts
with an annotation, so a reader can tell what still comes from `InMemoryCache` and what we
changed. Mechanical porting under rules 1–5 needs none.

```ts
// fast-gql-cache-rs: implementation
//   from: cache/inmemory/__tests__/policies.ts, "runs nested merge functions as well as ancestors" (line 4473)
//   changed: the two concat merge functions are written as `{ list: "append" }` descriptors
//   behaviour: unchanged, Apollo's assertions are kept
it("runs nested merge functions as well as ancestors (descriptors)", function () {
```

| Line | Holds |
| --- | --- |
| `fast-gql-cache-rs:` | the kind: **`implementation`** (the setup or wiring changed, every assertion is Apollo's), **`behaviour`** (an assertion changed: what the cache does differs from `InMemoryCache`) or **`new`** (no Apollo original) |
| `from:` | Apollo's file, test name and line at `@apollo/client@4.2.11`, for `implementation` and `behaviour`; for `new`, the invariant, ADR or finding the test pins |
| `changed:` | what differs from the original, concretely |
| `behaviour:` | `unchanged` for `implementation`. For `behaviour`, the old and the new behaviour, and the [drift register](../../docs/compatibility.md#behaviour-drift) entry that records it; a behaviour change without an entry is not allowed |

Keep Apollo's original test next to a changed copy whenever it still runs, so the oracle
never shrinks to our own expectations. A configuration the cache rejects is not deleted:
its original test stays, listed with the reason it fails.

`helpers.ts` exports `StoreReader` and `StoreWriter` subclasses that accept an
`InMemoryCacheRs`, so suites that drive Apollo's reader and writer directly keep their
bodies. Its `defaultNormalizedCacheFactory` and `writeQueryToStore` build today's
`EntityStore`; when Rust-WASM replaces the store
([ADR 0001](../../docs/adr/0001-js-rust-wasm-boundary.md), Phase 2), switching them to
the Rust store turns `diffAgainstStore`, `readFromStore`, `writeToStore`, `roundtrip`
and `recordingCache` into its oracle.

Apollo's custom matchers that these suites use (`toBeOneOf`, `toEmitAnything`,
`toEmitTypedValue`, `toStrictEqualTyped`) are copied into `src/testUtils/matchers/`,
because `tsconfig.json` roots at `src/`. `config/jest/setup.ts` registers Apollo's
equality testers from the submodule, as Apollo's own setup does.
