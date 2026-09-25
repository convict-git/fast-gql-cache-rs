# fast-gql-cache-rs

Rust-WASM `InMemoryCache` implementation for Apollo Client, published as the npm package
`fast-gql-cache-rs`. The public surface is `InMemoryCacheRs` / `InMemoryCacheRsConfig`
(`src/index.ts`); the WASM core lives in `wasm/` and the TypeScript shell delegates to
Apollo collaborators. Research on the cache being replaced (architecture, costs, the
build order for a re-implementation) is in `docs/README.md`.

These conventions bind every change. Breaking one requires explicit user approval and the
reasoning recorded in the commit/PR message.

## Development vs production code

Every file is one of two kinds, and the kind decides how it may use the `apollo-client-sm`
submodule (Apollo Client source at `@apollo/client@4.2.11`):

| Kind | What it includes | `apollo-client-sm` |
| --- | --- | --- |
| **Production** (shipped) | `src/` except `__tests__` and `testUtils`, `wasm/`, published `dist/` and `pkg/` | Behaviour reference only. Imports come from `node_modules/@apollo/client` per the import rules below. |
| **Development** | Tests, Jest/ESLint/TS/Prettier config, build scripts, probes | Import or `extends` it directly, to reuse Apollo's config and test utilities instead of duplicating them. |

Confirm any claim about Apollo Client behaviour against `apollo-client-sm/src/` before
stating it.

## Package boundaries

- **Public export**: only `InMemoryCacheRs` and `InMemoryCacheRsConfig`. WASM bindings and
  other classes stay internal.
- **Apollo version**: `@apollo/client@4.2.11`, both dev dependency and peer dependency.
- **Config type**: `InMemoryCacheRsConfig` is our own interface, not an extension of
  Apollo's `InMemoryCacheConfig`. It mirrors Apollo's option shapes for drop-in migration
  and will grow Rust-WASM-specific options.

## Import rules (production code)

Resolve an Apollo symbol by the first option that works, in order:

1. **Public entry point**: `@apollo/client`, `@apollo/client/cache`,
   `@apollo/client/utilities`, etc. Check runtime resolution
   (`node -e "import('@apollo/client/cache').then(...)"`) and the `exports` map in
   `node_modules/@apollo/client/package.json`; deep paths that land in
   `legacyEntryPoints` do not resolve.
2. **`patch-package` re-export**: when the module ships but is not exported, and we will
   keep delegating to Apollo's implementation, extend `patches/@apollo+client+4.2.11.patch`
   to re-export it and list it in `patches/README.md`.
3. **Local copy in `src/internal/`** (last resort, after 1 and 2 are ruled out): copy the
   smallest extraction from `apollo-client-sm`, and head the file with what was tried, which
   Apollo path it mirrors, and that it is slated for Rust-WASM replacement.

Apollo implementation lives in exactly one place. The allowed copies are
`InMemoryCacheRs.ts` (our implementation), `InMemoryCacheRsConfig.ts`, `src/internal/*`
per rule 3, and tests adapted from Apollo's `InMemoryCache` suite. `ApolloCache` and
`EntityStore` are imported from `@apollo/client/cache`.

## Dev tooling

Reuse `apollo-client-sm` config so ours cannot drift from Apollo's:

- **TypeScript**: `extends` the submodule's `tsconfig*.json`, overriding only `rootDir`,
  `outDir`, `include`.
- **Prettier**: `--config apollo-client-sm/.prettierrc` (carries Apollo's plugins).
- **Jest**: Apollo's environment, setup and matchers; project overrides are limited to
  `testMatch` and `moduleNameMapper` (generated `pkg/`, `@apollo/client/testing/internal`).
- **ESLint**: project-local `eslint.config.mjs`, aligned with Apollo where practical.

## Implementation strategy

- **Phase 1 (current)**: `InMemoryCacheRs` implements the `ApolloCache` abstract API
  (`apollo-client-sm/src/cache/core/cache.ts`): required methods first, optional
  overrides only where `InMemoryCache` behaviour needs them. It delegates to Apollo's
  `EntityStore`, `Policies`, `StoreReader`, `StoreWriter`, and is the sole TypeScript ↔
  WASM interop surface.
- **Phase 2**: replace `StoreReader`, `StoreWriter` and `src/internal/` modules with
  Rust-WASM, dropping each patched symbol once nothing imports it.
- `npm test` (the `InMemoryCache` parity suite) and `npm run probe:parity` (the behaviour
  probe's output, byte for byte against Apollo's) pass before advancing a phase.
  `npm run probe:compare -- --runs=5` measures whether a change made the cache faster.

## Skills

- **Rust/WASM work**: the `rust-skills` skill (`.claude/skills/rust-skills`, a link to the
  `.cursor/skills/rust-skills` submodule). Open only the rule files relevant to the change.
- **Apollo Client usage from an application's side** (cache policies, reactive variables):
  `apollo-client-sm/.claude/skills/apollo-client/SKILL.md`.

## Agent skills

### Issue tracker

GitHub Issues on `convict-git/fast-gql-cache-rs`, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label named after its role. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Environment and toolchain

Standard scripts live in `package.json`. The notes below are the non-obvious bits; the
Cursor Cloud startup script (`.cursor/environment.json`) handles the first three.

- **Node from `.nvmrc`** (`nvm use`). Node 24.6.x fails every Jest suite with "module is
  already linked" (nodejs/node#59480), and `jest.config.mjs` refuses to start on it; the
  submodule's CommonJS-loaded Jest environment needs Node 22.12+.
- **Submodules are required.** `apollo-client-sm` backs the Jest environment
  (`apollo-client-sm/config/FixJSDOMEnvironment.js`), `tsconfig*.json` `extends`, the
  Prettier config, and the `@apollo/client/testing/internal` mapping. Its `.gitmodules`
  URL is SSH, which fails in cloud; override it to HTTPS before
  `git submodule update` (as the README setup does). `rust-skills` is optional.
- **Rust stable + `wasm32-unknown-unknown`** (`wasm/rust-toolchain.toml`).
- `npm install` runs `patch-package` (`postinstall`) to patch `@apollo/client`; keep it.

### Building the WASM `pkg/`

`pkg/` (repo root) is gitignored and must be generated before typecheck/tests:

- `npm run wasm:dev` (debug) or `npm run wasm:build` (release) emits **two** artifacts the
  codebase depends on: `pkg/fast_gql_cache_rs.js` (web-target ESM, imported by
  `src`/`dist`) and `pkg/fast_gql_cache_rs.cjs` (nodejs-target CommonJS that initializes
  the wasm synchronously; Jest loads this one via `moduleNameMapper`).
- `npm run typecheck` and `npm test` do **not** build wasm; `npm run test:ci` does.
- The `InMemoryCacheRs` constructor calls into wasm synchronously, so a standalone Node
  script using the web ESM build must `initSync(...)` the wasm before constructing the
  cache; Jest avoids this by using the nodejs `.cjs`.

### Test / lint notes

- Tests are adapted copies of Apollo's own `InMemoryCache` suite; `eslint.config.mjs`
  relaxes preset style rules for `src/**/__tests__/**` while keeping the library sources
  strict.
- `tsconfig.tests.json` downlevels `target` so ts-jest transforms `using` (explicit
  resource management), which Node's runtime parser does not accept natively.
