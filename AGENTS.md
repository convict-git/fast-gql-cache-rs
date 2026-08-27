# fast-gql-cache-rs

Rust-WASM `InMemoryCache` implementation for Apollo Client. The public surface is
`InMemoryCacheRs` / `InMemoryCacheRsConfig` (`src/index.ts`); the WASM core lives in
`wasm/` and the TypeScript shell delegates to Apollo collaborators. See `.cursor/rules`
for the development-vs-production import rules.

## Cursor Cloud specific instructions

Standard scripts live in `package.json` (`build`, `build:ts`, `typecheck`, `lint`,
`test`, `test:ci`, `wasm:dev`, `wasm:build`). Notes below are the non-obvious bits.

### Toolchain / dependencies (handled by the startup update script)

- **Submodules are required.** `apollo-client-sm` (Apollo Client source, pinned to
  `@apollo/client@4.2.11`) backs the dev tooling: the Jest environment
  (`apollo-client-sm/config/FixJSDOMEnvironment.js`), `tsconfig*.json` `extends`,
  the Prettier config, and the `@apollo/client/testing/internal` module mapping.
  Nothing works without it. Its `.gitmodules` URL is SSH
  (`git@github.com:apollographql/apollo-client.git`), which fails in cloud; the update
  script overrides it to HTTPS before `git submodule update`. `rust-skills` is optional.
- **Rust nightly + `wasm32-unknown-unknown`** are required (`wasm/rust-toolchain.toml`).
- `npm install` runs `patch-package` (`postinstall`) to patch `@apollo/client` — do not
  skip it.

### Building the WASM `pkg/` (not done by the update script)

`pkg/` (repo root) is gitignored and must be generated before typecheck/tests:

- `npm run wasm:dev` (debug) or `npm run wasm:build` (release) builds it. The build emits
  **two** artifacts the codebase depends on: `pkg/fast_gql_cache_rs.js` (web-target ESM,
  imported by `src`/`dist`) and `pkg/fast_gql_cache_rs.cjs` (nodejs-target CommonJS that
  self-initializes the wasm synchronously — this is the file Jest actually loads via the
  `moduleNameMapper` in `jest.config.mjs`).
- `npm run typecheck` and `npm test` do **not** build wasm; run a wasm build first, or they
  fail to resolve `../pkg/fast_gql_cache_rs.js`. `npm run test:ci` builds wasm itself.
- The `InMemoryCacheRs` constructor calls into wasm synchronously, so for a standalone Node
  script using the web ESM build you must `initSync(...)` the wasm before constructing the
  cache; Jest avoids this by using the nodejs `.cjs`.

### Test / lint notes

- Tests are adapted copies of Apollo's own `InMemoryCache` suite; `eslint.config.mjs`
  intentionally relaxes preset style rules for `src/**/__tests__/**` while keeping the
  library sources strict.
- `tsconfig.tests.json` downlevels `target` so ts-jest transforms `using`
  (explicit resource management) — Node's runtime parser does not accept it natively.
