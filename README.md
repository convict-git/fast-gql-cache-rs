# fast-gql-cache-rs - A rust-wasm based InMemoryCache implementation for apollo-client
Currently in the proof-of-concept phase, a drop-in replacement for [apollo-client’s `InMemoryCache`](https://www.apollographql.com/docs/react/v3/api/cache/InMemoryCache), intended to **improve client-side GraphQL caching performance** by moving performance-critical hot paths like read, write, and normalization to **Rust-WebAssembly** while minimizing JavaScript single-thread overhead, expecting smoother frame rates and near-zero loss of interactivity for applications with l**arge normalized stores and write-heavy workloads**.

## Proof-of-concept research: findings so far

This project is still a proof of concept. The documents below capture the research done so
far into the cache it replaces, Apollo Client's `InMemoryCache` (`@apollo/client@4.2.11`):
how every path works, what each one costs, and what a drop-in replacement has to preserve.
They record the current findings and will change as the port progresses.

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

<!-- toc:end -->

## Setup dev environment

```bash
git config submodule.apollo-client-sm.url https://github.com/apollographql/apollo-client.git
git submodule update --init --recursive --depth 1
nvm use  # Node from .nvmrc; Node 24.6.x cannot run the ESM Jest suite (nodejs/node#59480)
npm install

# Skip the toolchain update if the stable wasm32 target is already installed.
# On overlayfs-backed containers (common in cloud CI/agents), rustup's default
# atomic rename can fail with EXDEV during an update; RUSTUP_PERMIT_COPY_RENAME
# tells it to use a copy fallback instead.
if ! rustup target list --toolchain stable --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown'; then
  export RUSTUP_PERMIT_COPY_RENAME=true
  rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown
fi
```
