# fast-gql-cache-rs

A Rust-WebAssembly cache for [Apollo Client](https://www.apollographql.com/docs/react/),
built as an alternative to its
[`InMemoryCache`](https://www.apollographql.com/docs/react/caching/overview) for
applications with large normalized stores and write-heavy workloads.

> **Status: research and a development scaffold. Not usable yet, and not released.**
> `InMemoryCacheRs` implements Apollo's `ApolloCache` API today by delegating to Apollo's
> own store, reader and writer; the Rust core is still a stub. The package does not work
> outside this repository yet: it depends on a development-only patch of `@apollo/client`,
> and its WASM initialization is not built.

## The goal

In `InMemoryCache`, every write normalizes the result, re-reads the queries it touched and
notifies their watchers, all synchronously on the main thread. For a large or frequently
polled store that work shows up as blocked frames and delayed input. The aim is to do it in
Rust-WebAssembly, so a write finishes sooner and hands the main thread back to rendering
and input earlier than `InMemoryCache` does.

That is the hypothesis the project exists to test, not a result. The
[performance guide](docs/performance/README.md) measures Apollo's cache under Node; nothing
has been measured in a browser yet.

## Not a drop-in replacement

The design ([ADR 0004](docs/adr/0004-declarative-policies-rust-engine.md), accepted, not
yet built) accepts **declarative** cache configuration only:

- `keyFields` and `keyArgs` as field lists, and `possibleTypes` as a map of type names;
- `merge` and `read` behaviours chosen from a fixed set of descriptors that covers
  Apollo's pagination helpers and common policy idioms.

Custom `read` and `merge` functions, function-valued `keyFields`/`keyArgs` and
`dataIdFromObject` are rejected when the cache is constructed, with an error that names
each one. In exchange, no policy function runs inside a cache read or write, and Rust never
calls application code, which lets the store, the writer, the reader and invalidation all
move into Rust. Within that profile
the target is `InMemoryCache`'s behaviour
([ADR 0002](docs/adr/0002-compatibility-target.md)), checked against Apollo's own test
suite.

## Research: findings so far

The documents below capture the research into the cache this project replaces, Apollo
Client's `InMemoryCache` (`@apollo/client@4.2.11`): how every path works, what each one
costs, and what a replacement has to preserve. They record the current findings and will
change as the work progresses.

Start at the [documentation home](docs/README.md) for reading paths and a section-level
table of contents.

<!-- toc:start -->

### [Architecture guide](docs/architecture/README.md): what every path does

- [Part 0 — Orientation](docs/architecture/00-orientation.md)
- [Part 1 — Foundations](docs/architecture/01-foundations.md)
- [Part 2 — The normalized store](docs/architecture/02-normalized-store.md)
- [Part 3 — `Policies`](docs/architecture/03-policies.md)
- [Part 4 — `StoreWriter`](docs/architecture/04-store-writer.md)
- [Part 5 — `StoreReader`](docs/architecture/05-store-reader.md)
- [Part 6 — Reactivity](docs/architecture/06-reactivity.md)
- [Part 7 — Method-by-method reference](docs/architecture/07-method-reference.md)
- [Part 8 — The cache in the Apollo Client pipeline](docs/architecture/08-client-pipeline.md)
- [Part 9 — Invariants and a re-implementation checklist](docs/architecture/09-invariants-and-checklist.md)

### [Performance guide](docs/performance/README.md): what every path costs

- [Part 1 — The cost model in one page](docs/performance/01-cost-model.md)
- [Part 2 — The write path](docs/performance/02-write-path.md)
- [Part 3 — The read path](docs/performance/03-read-path.md)
- [Part 4 — The dependency graph and broadcast](docs/performance/04-dependency-graph-and-broadcast.md)
- [Part 5 — Layers and optimistic updates](docs/performance/05-layers-and-optimistic-updates.md)
- [Part 6 — Lifecycle operations](docs/performance/06-lifecycle-operations.md)
- [Part 7 — Structural properties that stress the hot paths](docs/performance/07-structural-stress.md)
- [Part 8 — Worst-case shapes and a stress corpus](docs/performance/08-worst-case-shapes.md)
- [Part 9 — Optimization playbook](docs/performance/09-optimization-playbook.md)

### [Probes](docs/README.md#probes): executable checks

- [Behaviour probe](docs/probes/cache-behavior-probe.mjs): 78 assertions that pin the
  behaviour described in the architecture guide
- [Performance probe](docs/probes/cache-performance-probe.mjs): produces every table in the
  performance guide; its output is committed as
  [`cache-performance-probe.log`](docs/probes/cache-performance-probe.log)
- [Benchmarking](docs/benchmarking.md): how each PR's performance effect is measured
  (the `benchmark` label) and tracked nightly on the `benchmarks` branch

<!-- toc:end -->

## Setup dev environment

Versions are pinned: Node in `.nvmrc`, Rust (with the `wasm32-unknown-unknown` target,
`rustfmt` and `clippy`) in `rust-toolchain.toml`, dependencies in `package-lock.json` and
`wasm/Cargo.lock`. You need `git`, [`nvm`](https://github.com/nvm-sh/nvm) and
[`rustup`](https://rustup.rs).

```bash
git submodule update --init --recursive --depth 1
nvm install        # the Node version in .nvmrc
npm ci
# Installs the Rust toolchain rust-toolchain.toml pins. RUSTUP_PERMIT_COPY_RENAME
# avoids an EXDEV rename failure on overlayfs-backed containers (cloud CI/agents).
RUSTUP_PERMIT_COPY_RENAME=true rustup toolchain install
npm run wasm:dev   # builds pkg/, which typecheck and tests import
npm test
```

CI (`.github/workflows/ci.yml`) runs the same steps.
