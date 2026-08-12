# patch-package patches

Patches apply on `npm install` (`postinstall`).

## `@apollo/client@4.2.11`

Re-exports internal cache modules required by `InMemoryCacheRs` that are not
included in Apollo's public `exports` map:

- `forgetCache`, `recallCache` (reactive variable ↔ cache wiring)
- `hasOwn`, `normalizeConfig`, `StoreReader`, `StoreWriter`
- `supportsResultCaching`, `maybeDependOnExistenceOfEntity`
- `defaultCacheSizes` (re-exported from `@apollo/client/cache`)

Verified: deep imports like `@apollo/client/cache/inmemory/helpers.js` resolve to
missing `legacyEntryPoints` without this patch.

Prefer extending this patch over copying Apollo implementation files into
`src/internal/`. Remove symbols from the patch when Rust-WASM replaces them.
