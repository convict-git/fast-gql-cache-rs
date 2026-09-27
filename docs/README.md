# fast-gql-cache-rs documentation

The documentation covers two different caches. Keep them apart:

- **`InMemoryCacheRs`**, this project: a Rust-WASM cache for Apollo Client. Its design,
  decisions and compatibility are below under *This project*.
- **`InMemoryCache`**, Apollo Client's own cache (`@apollo/client@4.2.11`), which
  `InMemoryCacheRs` replaces. The [research](research/README.md) describes it in enough
  depth to re-implement it, derived from the `apollo-client-sm` submodule at `ba511be`, and
  executable probes pin the claims that can be observed or measured. Every research page
  says so at the top, and other documents cite it as "Apollo architecture §N.M" and
  "Apollo performance §N.M".

### This project: `InMemoryCacheRs`

| | What it covers | Start at |
| --- | --- | --- |
| **RFC 0001: the architecture of `InMemoryCacheRs`** | The proposed Rust-WASM design, explained level by level, from the idea to its contracts and plan | [rfc/0001](rfc/0001-inmemorycachers-architecture/README.md) |
| **ADRs** | The decisions of record, and the evidence for each | [adr/](adr/) |
| **Migrating** | What `InMemoryCacheRs` does not support, and where it behaves differently | [Compatibility with `InMemoryCache`](compatibility.md): [unsupported features](compatibility.md#unsupported-features), [behaviour drift](compatibility.md#behaviour-drift) |
| **Benchmarking** | How each PR's performance and memory effect is measured, and the nightly history | [benchmarking.md](benchmarking.md) |

### Research: Apollo's `InMemoryCache`

| | What it covers | Start at |
| --- | --- | --- |
| **Apollo architecture guide** | What every path of Apollo's cache *does*: the store, policies, writer, reader, reactivity, every public method, and the client pipeline around the cache | [research/architecture/](research/architecture/README.md) |
| **Apollo performance guide** | What every path of Apollo's cache *costs*, which data shapes stress it, and what to optimize | [research/performance/](research/performance/README.md) |
| **Probes** | A behaviour oracle (78 assertions), a performance probe and a memory probe, run against Apollo's cache and, with `--cache=rs`, against `InMemoryCacheRs` | [Probes](#probes) |

## Reading paths

Pick the path that matches your goal. Each step is one chapter or section.

- **Review the proposed `InMemoryCacheRs` design.** [RFC 0001](rfc/0001-inmemorycachers-architecture/README.md)
  from Level 1, then the ADRs it links (the decisions of record) in
  [adr/](adr/).
- **Learn Apollo's cache from scratch.** Apollo architecture [Part 0](research/architecture/00-orientation.md)
  through [Part 6](research/architecture/06-reactivity.md) in order, then the invariants in
  [§9.1](research/architecture/09-invariants-and-checklist.md#91-the-invariants).
- **Debug a UI that did not update, or updated too often, with Apollo's cache.** The equality gate in
  [§6.2](research/architecture/06-reactivity.md#62-broadcastwatch-and-the-equality-gate), the
  client side in [§8.2](research/architecture/08-client-pipeline.md#82-observablequery--the-caches-principal-client)
  and [§8.7](research/architecture/08-client-pipeline.md#87-broadcast--notify--reobserve), then the
  symptom table in [§9.5](research/architecture/09-invariants-and-checklist.md#95-where-to-look-when-something-is-wrong).
- **Find out why Apollo's cache is slow.** Apollo performance [Part 1](research/performance/01-cost-model.md),
  then [Part 7](research/performance/07-structural-stress.md), then the decision tree in
  [§9.1](research/performance/09-optimization-playbook.md#91-decision-tree).
- **Re-implement Apollo's cache.** Apollo architecture [Part 9](research/architecture/09-invariants-and-checklist.md)
  (invariants, build order, minimum surface) and the
  [method reference](research/architecture/07-method-reference.md); the performance
  [stress corpus](research/performance/08-worst-case-shapes.md#82-a-stress-test-corpus-for-a-re-implementation)
  and [re-implementation targets](research/performance/09-optimization-playbook.md#94-what-a-rustwasm-re-implementation-should-target);
  then validate against the [behaviour probe](#probes).

## Contents of the research

<!-- toc:start -->

### [Apollo architecture guide](research/architecture/README.md)

- **[Part 0 — Orientation](research/architecture/00-orientation.md)**
  - [0.1 The one-paragraph mental model](research/architecture/00-orientation.md#01-the-one-paragraph-mental-model)
  - [0.2 The blog's example, as the cache actually stores it](research/architecture/00-orientation.md#02-the-blogs-example-as-the-cache-actually-stores-it)
  - [0.3 File map](research/architecture/00-orientation.md#03-file-map)
  - [0.4 Vocabulary](research/architecture/00-orientation.md#04-vocabulary)
  - [0.5 The whole machine in one diagram](research/architecture/00-orientation.md#05-the-whole-machine-in-one-diagram)
- **[Part 1 — Foundations](research/architecture/01-foundations.md)**
  - [1.1 `optimism` — memoization with automatic dependency tracking](research/architecture/01-foundations.md#11-optimism--memoization-with-automatic-dependency-tracking)
  - [1.2 `@wry/trie` — tuples as stable object identities](research/architecture/01-foundations.md#12-wrytrie--tuples-as-stable-object-identities)
  - [1.3 `@wry/caches` — the LRU behind every memo](research/architecture/01-foundations.md#13-wrycaches--the-lru-behind-every-memo)
  - [1.4 `@wry/equality` — the change detector](research/architecture/01-foundations.md#14-wryequality--the-change-detector)
  - [1.5 `DeepMerger` — merging with maximal structure sharing](research/architecture/01-foundations.md#15-deepmerger--merging-with-maximal-structure-sharing)
  - [1.6 `canonicalStringify` — deterministic keys](research/architecture/01-foundations.md#16-canonicalstringify--deterministic-keys)
  - [1.7 `maybeDeepFreeze` — the immutability contract](research/architecture/01-foundations.md#17-maybedeepfreeze--the-immutability-contract)
- **[Part 2 — The normalized store](research/architecture/02-normalized-store.md)**
  - [2.1 The layer chain](research/architecture/02-normalized-store.md#21-the-layer-chain)
  - [2.2 Reading a field through the chain](research/architecture/02-normalized-store.md#22-reading-a-field-through-the-chain)
  - [2.3 `NormalizedCacheObject` and `__META`](research/architecture/02-normalized-store.md#23-normalizedcacheobject-and-__meta)
  - [2.4 `CacheGroup` — the dependency graph](research/architecture/02-normalized-store.md#24-cachegroup--the-dependency-graph)
  - [2.5 State transitions of a single `(dataId, storeFieldName)`](research/architecture/02-normalized-store.md#25-state-transitions-of-a-single-dataid-storefieldname)
  - [2.6 Writes: `merge` and `storeObjectReconciler`](research/architecture/02-normalized-store.md#26-writes-merge-and-storeobjectreconciler)
  - [2.7 `modify` — user-controlled field surgery](research/architecture/02-normalized-store.md#27-modify--user-controlled-field-surgery)
  - [2.8 `evict` — deletion across the layer chain](research/architecture/02-normalized-store.md#28-evict--deletion-across-the-layer-chain)
  - [2.9 Garbage collection](research/architecture/02-normalized-store.md#29-garbage-collection)
  - [2.10 Layer removal and replay](research/architecture/02-normalized-store.md#210-layer-removal-and-replay)
- **[Part 3 — `Policies`](research/architecture/03-policies.md)**
  - [3.1 Lazy materialisation and supertype inheritance](research/architecture/03-policies.md#31-lazy-materialisation-and-supertype-inheritance)
  - [3.2 Entity identity: `Policies.identify`](research/architecture/03-policies.md#32-entity-identity-policiesidentify)
  - [3.3 Field identity: `getStoreFieldName`](research/architecture/03-policies.md#33-field-identity-getstorefieldname)
  - [3.4 `readField` — the field read entry point](research/architecture/03-policies.md#34-readfield--the-field-read-entry-point)
  - [3.5 Merge functions](research/architecture/03-policies.md#35-merge-functions)
  - [3.6 `fragmentMatches` — type-condition resolution](research/architecture/03-policies.md#36-fragmentmatches--type-condition-resolution)
- **[Part 4 — `StoreWriter`](research/architecture/04-store-writer.md)**
  - [4.1 `writeToStore` — the driver](research/architecture/04-store-writer.md#41-writetostore--the-driver)
  - [4.2 `processSelectionSet` — the recursive core](research/architecture/04-store-writer.md#42-processselectionset--the-recursive-core)
  - [4.3 `flattenFields` — field collection with directive tracking](research/architecture/04-store-writer.md#43-flattenfields--field-collection-with-directive-tracking)
  - [4.4 `processFieldValue` — scalars, arrays, recursion](research/architecture/04-store-writer.md#44-processfieldvalue--scalars-arrays-recursion)
  - [4.5 Identification and the `keyObject` back-channel](research/architecture/04-store-writer.md#45-identification-and-the-keyobject-back-channel)
  - [4.6 `MergeTree` and `applyMerges`](research/architecture/04-store-writer.md#46-mergetree-and-applymerges)
  - [4.7 The duplicate guard and the `isFresh` short-circuit](research/architecture/04-store-writer.md#47-the-duplicate-guard-and-the-isfresh-short-circuit)
  - [4.8 `warnAboutDataLoss`](research/architecture/04-store-writer.md#48-warnaboutdataloss)
  - [4.9 The full write, end to end](research/architecture/04-store-writer.md#49-the-full-write-end-to-end)
  - [4.10 Write-path state transitions](research/architecture/04-store-writer.md#410-write-path-state-transitions)
- **[Part 5 — `StoreReader`](research/architecture/05-store-reader.md)**
  - [5.1 The two memoized functions](research/architecture/05-store-reader.md#51-the-two-memoized-functions)
  - [5.2 `diffQueryAgainstStore`](research/architecture/05-store-reader.md#52-diffqueryagainststore)
  - [5.3 `execSelectionSetImpl`](research/architecture/05-store-reader.md#53-execselectionsetimpl)
  - [5.4 `execSubSelectedArrayImpl`](research/architecture/05-store-reader.md#54-execsubselectedarrayimpl)
  - [5.5 The missing tree](research/architecture/05-store-reader.md#55-the-missing-tree)
  - [5.6 Immutability and `knownResults`](research/architecture/05-store-reader.md#56-immutability-and-knownresults)
  - [5.7 What a read leaves behind](research/architecture/05-store-reader.md#57-what-a-read-leaves-behind)
  - [5.8 Reading with `optimistic: true`](research/architecture/05-store-reader.md#58-reading-with-optimistic-true)
- **[Part 6 — Reactivity](research/architecture/06-reactivity.md)**
  - [6.1 `watch`](research/architecture/06-reactivity.md#61-watch)
  - [6.2 `broadcastWatch` and the equality gate](research/architecture/06-reactivity.md#62-broadcastwatch-and-the-equality-gate)
  - [6.3 `txCount` — broadcast batching](research/architecture/06-reactivity.md#63-txcount--broadcast-batching)
  - [6.4 `batch` — the transactional API](research/architecture/06-reactivity.md#64-batch--the-transactional-api)
  - [6.5 Optimistic lifecycle, end to end](research/architecture/06-reactivity.md#65-optimistic-lifecycle-end-to-end)
  - [6.6 Reactive variables](research/architecture/06-reactivity.md#66-reactive-variables)
  - [6.7 `watchFragment` — the observable layer on top of `watch`](research/architecture/06-reactivity.md#67-watchfragment--the-observable-layer-on-top-of-watch)
- **[Part 7 — Method-by-method reference](research/architecture/07-method-reference.md)**
  - [7.1 `read`](research/architecture/07-method-reference.md#71-read)
  - [7.2 `diff`](research/architecture/07-method-reference.md#72-diff)
  - [7.3 `write`](research/architecture/07-method-reference.md#73-write)
  - [7.4 `modify`](research/architecture/07-method-reference.md#74-modify)
  - [7.5 `evict`](research/architecture/07-method-reference.md#75-evict)
  - [7.6 `watch`](research/architecture/07-method-reference.md#76-watch)
  - [7.7 `batch` / `performTransaction`](research/architecture/07-method-reference.md#77-batch--performtransaction)
  - [7.8 `removeOptimistic`](research/architecture/07-method-reference.md#78-removeoptimistic)
  - [7.9 `gc`](research/architecture/07-method-reference.md#79-gc)
  - [7.10 `retain` / `release`](research/architecture/07-method-reference.md#710-retain--release)
  - [7.11 `extract`](research/architecture/07-method-reference.md#711-extract)
  - [7.12 `restore`](research/architecture/07-method-reference.md#712-restore)
  - [7.13 `reset`](research/architecture/07-method-reference.md#713-reset)
  - [7.14 `identify`](research/architecture/07-method-reference.md#714-identify)
  - [7.15 `transformDocument` / `transformForLink`](research/architecture/07-method-reference.md#715-transformdocument--transformforlink)
  - [7.16 `fragmentMatches` / `lookupFragment` / `resolvesClientField`](research/architecture/07-method-reference.md#716-fragmentmatches--lookupfragment--resolvesclientfield)
  - [7.17 The inherited convenience layer](research/architecture/07-method-reference.md#717-the-inherited-convenience-layer)
  - [7.18 What `InMemoryCache` deliberately does *not* implement](research/architecture/07-method-reference.md#718-what-inmemorycache-deliberately-does-not-implement)
- **[Part 8 — The cache in the Apollo Client pipeline](research/architecture/08-client-pipeline.md)**
  - [8.0 The call map](research/architecture/08-client-pipeline.md#80-the-call-map)
  - [8.1 Document transforms — what the cache sees is not what you wrote](research/architecture/08-client-pipeline.md#81-document-transforms--what-the-cache-sees-is-not-what-you-wrote)
  - [8.2 `ObservableQuery` — the cache's principal client](research/architecture/08-client-pipeline.md#82-observablequery--the-caches-principal-client)
  - [8.3 Fetch policies as a cache-interaction table](research/architecture/08-client-pipeline.md#83-fetch-policies-as-a-cache-interaction-table)
  - [8.4 `QueryInfo.markQueryResult` — the write path and the feud breaker](research/architecture/08-client-pipeline.md#84-queryinfomarkqueryresult--the-write-path-and-the-feud-breaker)
  - [8.5 Mutations — optimistic layer, final write, root-field scrub](research/architecture/08-client-pipeline.md#85-mutations--optimistic-layer-final-write-root-field-scrub)
  - [8.6 `refetchQueries` — the batch-and-collect protocol](research/architecture/08-client-pipeline.md#86-refetchqueries--the-batch-and-collect-protocol)
  - [8.7 Broadcast → notify → reobserve](research/architecture/08-client-pipeline.md#87-broadcast--notify--reobserve)
  - [8.8 Local state and `@client` fields](research/architecture/08-client-pipeline.md#88-local-state-and-client-fields)
  - [8.9 Data masking](research/architecture/08-client-pipeline.md#89-data-masking)
  - [8.10 `resetStore` and `clearStore`](research/architecture/08-client-pipeline.md#810-resetstore-and-clearstore)
  - [8.11 Memory internals — the cache's own telemetry](research/architecture/08-client-pipeline.md#811-memory-internals--the-caches-own-telemetry)
- **[Part 9 — Invariants and a re-implementation checklist](research/architecture/09-invariants-and-checklist.md)**
  - [9.1 The invariants](research/architecture/09-invariants-and-checklist.md#91-the-invariants)
  - [9.2 Build order for a re-implementation](research/architecture/09-invariants-and-checklist.md#92-build-order-for-a-re-implementation)
  - [9.3 Cross-boundary requirements](research/architecture/09-invariants-and-checklist.md#93-cross-boundary-requirements)
  - [9.4 The minimum viable surface](research/architecture/09-invariants-and-checklist.md#94-the-minimum-viable-surface)
  - [9.5 Where to look when something is wrong](research/architecture/09-invariants-and-checklist.md#95-where-to-look-when-something-is-wrong)

### [Apollo performance guide](research/performance/README.md)

- **[Part 1 — The cost model in one page](research/performance/01-cost-model.md)**
  - [1.1 The four costs that matter](research/performance/01-cost-model.md#11-the-four-costs-that-matter)
  - [1.2 Headline complexity table](research/performance/01-cost-model.md#12-headline-complexity-table)
  - [1.3 Measured: the shape of the curves](research/performance/01-cost-model.md#13-measured-the-shape-of-the-curves)
  - [1.4 The one diagram to remember](research/performance/01-cost-model.md#14-the-one-diagram-to-remember)
- **[Part 2 — The write path](research/performance/02-write-path.md)**
  - [2.1 Where the time goes](research/performance/02-write-path.md#21-where-the-time-goes)
  - [2.2 The per-entity and per-field allocation budget](research/performance/02-write-path.md#22-the-per-entity-and-per-field-allocation-budget)
  - [2.3 The deep-equality tax](research/performance/02-write-path.md#23-the-deep-equality-tax)
  - [2.4 Field-key construction](research/performance/02-write-path.md#24-field-key-construction)
  - [2.5 Identity extraction](research/performance/02-write-path.md#25-identity-extraction)
  - [2.6 Merge functions](research/performance/02-write-path.md#26-merge-functions)
  - [2.7 Measured: write scaling](research/performance/02-write-path.md#27-measured-write-scaling)
- **[Part 3 — The read path](research/performance/03-read-path.md)**
  - [3.1 The memo graph *is* the read path](research/performance/03-read-path.md#31-the-memo-graph-is-the-read-path)
  - [3.2 The cost of a cold read](research/performance/03-read-path.md#32-the-cost-of-a-cold-read)
  - [3.3 Invalidation blast radius — the single most important read-path concept](research/performance/03-read-path.md#33-invalidation-blast-radius--the-single-most-important-read-path-concept)
  - [3.4 Structure sharing](research/performance/03-read-path.md#34-structure-sharing)
  - [3.5 Arrays](research/performance/03-read-path.md#35-arrays)
  - [3.6 The dev-build tax](research/performance/03-read-path.md#36-the-dev-build-tax)
- **[Part 4 — The dependency graph and broadcast](research/performance/04-dependency-graph-and-broadcast.md)**
  - [4.1 `depend` and `dirty`](research/performance/04-dependency-graph-and-broadcast.md#41-depend-and-dirty)
  - [4.2 Optimistic reads maintain a *second* set of memo entries](research/performance/04-dependency-graph-and-broadcast.md#42-optimistic-reads-maintain-a-second-set-of-memo-entries)
  - [4.3 The memo LRU cliff](research/performance/04-dependency-graph-and-broadcast.md#43-the-memo-lru-cliff)
  - [4.4 Broadcast fan-out](research/performance/04-dependency-graph-and-broadcast.md#44-broadcast-fan-out)
  - [4.5 Memo fragmentation by document identity](research/performance/04-dependency-graph-and-broadcast.md#45-memo-fragmentation-by-document-identity)
  - [4.6 Batching](research/performance/04-dependency-graph-and-broadcast.md#46-batching)
- **[Part 5 — Layers and optimistic updates](research/performance/05-layers-and-optimistic-updates.md)**
- **[Part 6 — Lifecycle operations](research/performance/06-lifecycle-operations.md)**
  - [6.1 `gc()` is `O(store)` unconditionally](research/performance/06-lifecycle-operations.md#61-gc-is-ostore-unconditionally)
  - [6.2 `evict` is cheap, its consequences are not](research/performance/06-lifecycle-operations.md#62-evict-is-cheap-its-consequences-are-not)
  - [6.3 `restore` versus `write`](research/performance/06-lifecycle-operations.md#63-restore-versus-write)
- **[Part 7 — Structural properties that stress the hot paths](research/performance/07-structural-stress.md)**
  - [7.0 The stress matrix](research/performance/07-structural-stress.md#70-the-stress-matrix)
  - [7.1 Depth (the worst offender)](research/performance/07-structural-stress.md#71-depth-the-worst-offender)
  - [7.2 Breadth](research/performance/07-structural-stress.md#72-breadth)
  - [7.3 Typed (normalized) versus untyped (embedded) data](research/performance/07-structural-stress.md#73-typed-normalized-versus-untyped-embedded-data)
  - [7.4 The untyped-blob pathology](research/performance/07-structural-stress.md#74-the-untyped-blob-pathology)
  - [7.5 Arrays of arrays](research/performance/07-structural-stress.md#75-arrays-of-arrays)
  - [7.6 Fan-in: many parents referencing one entity](research/performance/07-structural-stress.md#76-fan-in-many-parents-referencing-one-entity)
  - [7.7 Argument-heavy fields](research/performance/07-structural-stress.md#77-argument-heavy-fields)
  - [7.8 Polymorphism and fragments](research/performance/07-structural-stress.md#78-polymorphism-and-fragments)
  - [7.9 Repeated entities and cycles](research/performance/07-structural-stress.md#79-repeated-entities-and-cycles)
- **[Part 8 — Worst-case shapes and a stress corpus](research/performance/08-worst-case-shapes.md)**
  - [8.1 The four adversarial payloads](research/performance/08-worst-case-shapes.md#81-the-four-adversarial-payloads)
  - [8.2 A stress-test corpus for a re-implementation](research/performance/08-worst-case-shapes.md#82-a-stress-test-corpus-for-a-re-implementation)
- **[Part 9 — Optimization playbook](research/performance/09-optimization-playbook.md)**
  - [9.1 Decision tree](research/performance/09-optimization-playbook.md#91-decision-tree)
  - [9.2 Diagnostics](research/performance/09-optimization-playbook.md#92-diagnostics)
  - [9.3 Tuning knobs the cache actually exposes](research/performance/09-optimization-playbook.md#93-tuning-knobs-the-cache-actually-exposes)
  - [9.4 What a Rust/WASM re-implementation should target](research/performance/09-optimization-playbook.md#94-what-a-rustwasm-re-implementation-should-target)
- **[Part 10 — Memory](research/performance/10-memory.md)**
  - [10.1 The memo is where the memory is](research/performance/10-memory.md#101-the-memo-is-where-the-memory-is)
  - [10.2 By shape](research/performance/10-memory.md#102-by-shape)
  - [10.3 Allocation: what an operation throws away](research/performance/10-memory.md#103-allocation-what-an-operation-throws-away)
  - [10.4 Bounded is not small](research/performance/10-memory.md#104-bounded-is-not-small)
  - [10.5 Reclamation](research/performance/10-memory.md#105-reclamation)
  - [10.6 What a re-implementation should target](research/performance/10-memory.md#106-what-a-re-implementation-should-target)

<!-- toc:end -->

## Probes

Both probes import the installed `@apollo/client@4.2.11`. The repository's `patch-package`
patch only adds exports and does not change behaviour. Run `npm install` first, then run
the probes from the repository root.

**Behaviour probe:** [`probes/cache-behavior-probe.mjs`](probes/cache-behavior-probe.mjs).
It makes 78 assertions over the observable behaviour described in the Apollo architecture guide
and ends with `RESULT: all checks passed`.

```bash
node --conditions=development docs/probes/cache-behavior-probe.mjs
```

`--conditions=development` is required. Without it Node resolves the production build,
where result freezing and the data-loss warning are compiled out.

**Performance probe:** [`probes/cache-performance-probe.mjs`](probes/cache-performance-probe.mjs).
It produces every table in the Apollo performance guide. The committed output is
[`probes/cache-performance-probe.log`](probes/cache-performance-probe.log).

```bash
node --expose-gc docs/probes/cache-performance-probe.mjs --runs=5
```

It runs the production build on purpose. `--runs=5` measures every section in its own
fresh process, five times, and reports, for every timing, the median across the five
runs of each run's median; the committed log was made this way and ends with the
run-to-run spread. The raw aggregated data is committed next to it as
[`probes/cache-performance-probe.json`](probes/cache-performance-probe.json). `--quick`
gives a coarser run, and `--json` gives machine-readable output.

**Memory probe:** [`probes/cache-memory-probe.mjs`](probes/cache-memory-probe.mjs). It
measures retained and allocated bytes and checks that memory comes back, and it produces
every table in [Part 10](research/performance/10-memory.md) of the Apollo performance guide. The committed
output is [`probes/cache-memory-probe.log`](probes/cache-memory-probe.log), with its data in
[`probes/cache-memory-probe.json`](probes/cache-memory-probe.json).

```bash
node --expose-gc docs/probes/cache-memory-probe.mjs --runs=5
```

It takes the performance probe's flags. How it measures is in
[benchmarking.md](benchmarking.md#memory).

**Against `InMemoryCacheRs`.** Both probes take `--cache=apollo` (the default) or
`--cache=rs`, which runs them against this repository's cache, loaded from the built
`dist/` (see [`probes/select-cache.mjs`](probes/select-cache.mjs)). Two scripts build
`dist/` and compare the caches:

```bash
npm run probe:parity             # behaviour probe output must match Apollo's byte for byte
npm run probe:compare -- --runs=5  # every performance measurement side by side, with ratios
npm run probe:compare -- --probe=memory --runs=3  # the same for memory
```

Use `--runs=5` for comparisons you act on: a single `--quick` run swings microsecond
measurements by tens of percent even when both caches run the same code.
`npm run test:tooling` tests this tooling and the benchmark scripts. To compare a branch's
performance with another, see [benchmarking.md](benchmarking.md).

## Conventions

- **Source paths** are relative to `apollo-client-sm/src/`. Code snippets keep the source
  semantics but are condensed; the cited file has the exact text.
- **Section references** such as §2.4 are links. In the Apollo performance guide, a reference
  written "Apollo architecture §N.M" points into the Apollo architecture guide.
- **Diagrams** use one colour palette, explained in the
  [architecture legend](research/architecture/README.md#diagram-legend). They are written for
  GitHub's Mermaid renderer.
- **Navigation.** Every chapter has previous/next links at the top and bottom.
