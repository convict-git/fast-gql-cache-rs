# Research: Apollo Client's `InMemoryCache`

[Documentation home](../README.md) › Research

> **This folder is about Apollo Client's `InMemoryCache`, the cache this project replaces.**
> None of it describes `InMemoryCacheRs`. For that design, see
> [RFC 0001: The architecture of `InMemoryCacheRs`](../rfc/0001-inmemorycachers-architecture/README.md)
> and the [ADRs](../adr/).

Before writing any Rust, we took `InMemoryCache` (`@apollo/client@4.2.11`, the
`apollo-client-sm` submodule at `ba511be`) apart: how every path works, what each one
costs, and what a replacement has to preserve. The RFC and the ADRs cite these guides as
"Apollo architecture §N.M" and "Apollo performance §N.M".

## [Apollo architecture guide](architecture/README.md): what every path does

- [Part 0 — Orientation](architecture/00-orientation.md)
- [Part 1 — Foundations](architecture/01-foundations.md)
- [Part 2 — The normalized store](architecture/02-normalized-store.md)
- [Part 3 — `Policies`](architecture/03-policies.md)
- [Part 4 — `StoreWriter`](architecture/04-store-writer.md)
- [Part 5 — `StoreReader`](architecture/05-store-reader.md)
- [Part 6 — Reactivity](architecture/06-reactivity.md)
- [Part 7 — Method-by-method reference](architecture/07-method-reference.md)
- [Part 8 — The cache in the Apollo Client pipeline](architecture/08-client-pipeline.md)
- [Part 9 — Invariants and a re-implementation checklist](architecture/09-invariants-and-checklist.md)

## [Apollo performance guide](performance/README.md): what every path costs

- [Part 1 — The cost model in one page](performance/01-cost-model.md)
- [Part 2 — The write path](performance/02-write-path.md)
- [Part 3 — The read path](performance/03-read-path.md)
- [Part 4 — The dependency graph and broadcast](performance/04-dependency-graph-and-broadcast.md)
- [Part 5 — Layers and optimistic updates](performance/05-layers-and-optimistic-updates.md)
- [Part 6 — Lifecycle operations](performance/06-lifecycle-operations.md)
- [Part 7 — Structural properties that stress the hot paths](performance/07-structural-stress.md)
- [Part 8 — Worst-case shapes and a stress corpus](performance/08-worst-case-shapes.md)
- [Part 9 — Optimization playbook](performance/09-optimization-playbook.md)
- [Part 10 — Memory](performance/10-memory.md)

## Probes

The claims in both guides that can be observed or measured are pinned by executable probes
in [`docs/probes/`](../probes/), described on the
[documentation home](../README.md#probes). They run against Apollo's cache by default, and
against `InMemoryCacheRs` with `--cache=rs`, which is how the benchmark compares the two.
