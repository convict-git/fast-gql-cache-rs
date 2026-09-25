# `InMemoryCache` documentation

These documents describe Apollo Client's `InMemoryCache` (`@apollo/client@4.2.11`) in enough
depth to re-implement it. This repository's Rust-WASM `InMemoryCacheRs` targets that
behaviour. Everything is derived from the `apollo-client-sm` submodule at `ba511be`, and
two executable probes pin the claims that can be observed or measured.

| | What it covers | Start at |
| --- | --- | --- |
| **Architecture guide** | What every path *does*: the store, policies, writer, reader, reactivity, every public method, and the client pipeline around the cache | [architecture/](architecture/README.md) |
| **Performance guide** | What every path *costs*, which data shapes stress it, and what to optimize | [performance/](performance/README.md) |
| **Probes** | A behaviour oracle (78 assertions) and a performance probe | [Probes](#probes) |

## Reading paths

Pick the path that matches your goal. Each step is one chapter or section.

- **Learn the cache from scratch.** Architecture [Part 0](architecture/00-orientation.md)
  through [Part 6](architecture/06-reactivity.md) in order, then the invariants in
  [§9.1](architecture/09-invariants-and-checklist.md#91-the-invariants).
- **Debug a UI that did not update, or updated too often.** The equality gate in
  [§6.2](architecture/06-reactivity.md#62-broadcastwatch-and-the-equality-gate), the
  client side in [§8.2](architecture/08-client-pipeline.md#82-observablequery--the-caches-principal-client)
  and [§8.7](architecture/08-client-pipeline.md#87-broadcast--notify--reobserve), then the
  symptom table in [§9.5](architecture/09-invariants-and-checklist.md#95-where-to-look-when-something-is-wrong).
- **Find out why the cache is slow.** Performance [Part 1](performance/01-cost-model.md),
  then [Part 7](performance/07-structural-stress.md), then the decision tree in
  [§9.1](performance/09-optimization-playbook.md#91-decision-tree).
- **Re-implement the cache.** Architecture [Part 9](architecture/09-invariants-and-checklist.md)
  (invariants, build order, minimum surface) and the
  [method reference](architecture/07-method-reference.md); the performance
  [stress corpus](performance/08-worst-case-shapes.md#82-a-stress-test-corpus-for-a-re-implementation)
  and [re-implementation targets](performance/09-optimization-playbook.md#94-what-a-rustwasm-re-implementation-should-target);
  then validate against the [behaviour probe](#probes).

## Contents

<!-- toc:start -->

### [Architecture guide](architecture/README.md)

- **[Part 0 — Orientation](architecture/00-orientation.md)**
  - [0.1 The one-paragraph mental model](architecture/00-orientation.md#01-the-one-paragraph-mental-model)
  - [0.2 The blog's example, as the cache actually stores it](architecture/00-orientation.md#02-the-blogs-example-as-the-cache-actually-stores-it)
  - [0.3 File map](architecture/00-orientation.md#03-file-map)
  - [0.4 Vocabulary](architecture/00-orientation.md#04-vocabulary)
  - [0.5 The whole machine in one diagram](architecture/00-orientation.md#05-the-whole-machine-in-one-diagram)
- **[Part 1 — Foundations](architecture/01-foundations.md)**
  - [1.1 `optimism` — memoization with automatic dependency tracking](architecture/01-foundations.md#11-optimism--memoization-with-automatic-dependency-tracking)
  - [1.2 `@wry/trie` — tuples as stable object identities](architecture/01-foundations.md#12-wrytrie--tuples-as-stable-object-identities)
  - [1.3 `@wry/caches` — the LRU behind every memo](architecture/01-foundations.md#13-wrycaches--the-lru-behind-every-memo)
  - [1.4 `@wry/equality` — the change detector](architecture/01-foundations.md#14-wryequality--the-change-detector)
  - [1.5 `DeepMerger` — merging with maximal structure sharing](architecture/01-foundations.md#15-deepmerger--merging-with-maximal-structure-sharing)
  - [1.6 `canonicalStringify` — deterministic keys](architecture/01-foundations.md#16-canonicalstringify--deterministic-keys)
  - [1.7 `maybeDeepFreeze` — the immutability contract](architecture/01-foundations.md#17-maybedeepfreeze--the-immutability-contract)
- **[Part 2 — The normalized store](architecture/02-normalized-store.md)**
  - [2.1 The layer chain](architecture/02-normalized-store.md#21-the-layer-chain)
  - [2.2 Reading a field through the chain](architecture/02-normalized-store.md#22-reading-a-field-through-the-chain)
  - [2.3 `NormalizedCacheObject` and `__META`](architecture/02-normalized-store.md#23-normalizedcacheobject-and-__meta)
  - [2.4 `CacheGroup` — the dependency graph](architecture/02-normalized-store.md#24-cachegroup--the-dependency-graph)
  - [2.5 State transitions of a single `(dataId, storeFieldName)`](architecture/02-normalized-store.md#25-state-transitions-of-a-single-dataid-storefieldname)
  - [2.6 Writes: `merge` and `storeObjectReconciler`](architecture/02-normalized-store.md#26-writes-merge-and-storeobjectreconciler)
  - [2.7 `modify` — user-controlled field surgery](architecture/02-normalized-store.md#27-modify--user-controlled-field-surgery)
  - [2.8 `evict` — deletion across the layer chain](architecture/02-normalized-store.md#28-evict--deletion-across-the-layer-chain)
  - [2.9 Garbage collection](architecture/02-normalized-store.md#29-garbage-collection)
  - [2.10 Layer removal and replay](architecture/02-normalized-store.md#210-layer-removal-and-replay)
- **[Part 3 — `Policies`](architecture/03-policies.md)**
  - [3.1 Lazy materialisation and supertype inheritance](architecture/03-policies.md#31-lazy-materialisation-and-supertype-inheritance)
  - [3.2 Entity identity: `Policies.identify`](architecture/03-policies.md#32-entity-identity-policiesidentify)
  - [3.3 Field identity: `getStoreFieldName`](architecture/03-policies.md#33-field-identity-getstorefieldname)
  - [3.4 `readField` — the field read entry point](architecture/03-policies.md#34-readfield--the-field-read-entry-point)
  - [3.5 Merge functions](architecture/03-policies.md#35-merge-functions)
  - [3.6 `fragmentMatches` — type-condition resolution](architecture/03-policies.md#36-fragmentmatches--type-condition-resolution)
- **[Part 4 — `StoreWriter`](architecture/04-store-writer.md)**
  - [4.1 `writeToStore` — the driver](architecture/04-store-writer.md#41-writetostore--the-driver)
  - [4.2 `processSelectionSet` — the recursive core](architecture/04-store-writer.md#42-processselectionset--the-recursive-core)
  - [4.3 `flattenFields` — field collection with directive tracking](architecture/04-store-writer.md#43-flattenfields--field-collection-with-directive-tracking)
  - [4.4 `processFieldValue` — scalars, arrays, recursion](architecture/04-store-writer.md#44-processfieldvalue--scalars-arrays-recursion)
  - [4.5 Identification and the `keyObject` back-channel](architecture/04-store-writer.md#45-identification-and-the-keyobject-back-channel)
  - [4.6 `MergeTree` and `applyMerges`](architecture/04-store-writer.md#46-mergetree-and-applymerges)
  - [4.7 The duplicate guard and the `isFresh` short-circuit](architecture/04-store-writer.md#47-the-duplicate-guard-and-the-isfresh-short-circuit)
  - [4.8 `warnAboutDataLoss`](architecture/04-store-writer.md#48-warnaboutdataloss)
  - [4.9 The full write, end to end](architecture/04-store-writer.md#49-the-full-write-end-to-end)
  - [4.10 Write-path state transitions](architecture/04-store-writer.md#410-write-path-state-transitions)
- **[Part 5 — `StoreReader`](architecture/05-store-reader.md)**
  - [5.1 The two memoized functions](architecture/05-store-reader.md#51-the-two-memoized-functions)
  - [5.2 `diffQueryAgainstStore`](architecture/05-store-reader.md#52-diffqueryagainststore)
  - [5.3 `execSelectionSetImpl`](architecture/05-store-reader.md#53-execselectionsetimpl)
  - [5.4 `execSubSelectedArrayImpl`](architecture/05-store-reader.md#54-execsubselectedarrayimpl)
  - [5.5 The missing tree](architecture/05-store-reader.md#55-the-missing-tree)
  - [5.6 Immutability and `knownResults`](architecture/05-store-reader.md#56-immutability-and-knownresults)
  - [5.7 What a read leaves behind](architecture/05-store-reader.md#57-what-a-read-leaves-behind)
  - [5.8 Reading with `optimistic: true`](architecture/05-store-reader.md#58-reading-with-optimistic-true)
- **[Part 6 — Reactivity](architecture/06-reactivity.md)**
  - [6.1 `watch`](architecture/06-reactivity.md#61-watch)
  - [6.2 `broadcastWatch` and the equality gate](architecture/06-reactivity.md#62-broadcastwatch-and-the-equality-gate)
  - [6.3 `txCount` — broadcast batching](architecture/06-reactivity.md#63-txcount--broadcast-batching)
  - [6.4 `batch` — the transactional API](architecture/06-reactivity.md#64-batch--the-transactional-api)
  - [6.5 Optimistic lifecycle, end to end](architecture/06-reactivity.md#65-optimistic-lifecycle-end-to-end)
  - [6.6 Reactive variables](architecture/06-reactivity.md#66-reactive-variables)
  - [6.7 `watchFragment` — the observable layer on top of `watch`](architecture/06-reactivity.md#67-watchfragment--the-observable-layer-on-top-of-watch)
- **[Part 7 — Method-by-method reference](architecture/07-method-reference.md)**
  - [7.1 `read`](architecture/07-method-reference.md#71-read)
  - [7.2 `diff`](architecture/07-method-reference.md#72-diff)
  - [7.3 `write`](architecture/07-method-reference.md#73-write)
  - [7.4 `modify`](architecture/07-method-reference.md#74-modify)
  - [7.5 `evict`](architecture/07-method-reference.md#75-evict)
  - [7.6 `watch`](architecture/07-method-reference.md#76-watch)
  - [7.7 `batch` / `performTransaction`](architecture/07-method-reference.md#77-batch--performtransaction)
  - [7.8 `removeOptimistic`](architecture/07-method-reference.md#78-removeoptimistic)
  - [7.9 `gc`](architecture/07-method-reference.md#79-gc)
  - [7.10 `retain` / `release`](architecture/07-method-reference.md#710-retain--release)
  - [7.11 `extract`](architecture/07-method-reference.md#711-extract)
  - [7.12 `restore`](architecture/07-method-reference.md#712-restore)
  - [7.13 `reset`](architecture/07-method-reference.md#713-reset)
  - [7.14 `identify`](architecture/07-method-reference.md#714-identify)
  - [7.15 `transformDocument` / `transformForLink`](architecture/07-method-reference.md#715-transformdocument--transformforlink)
  - [7.16 `fragmentMatches` / `lookupFragment` / `resolvesClientField`](architecture/07-method-reference.md#716-fragmentmatches--lookupfragment--resolvesclientfield)
  - [7.17 The inherited convenience layer](architecture/07-method-reference.md#717-the-inherited-convenience-layer)
  - [7.18 What `InMemoryCache` deliberately does *not* implement](architecture/07-method-reference.md#718-what-inmemorycache-deliberately-does-not-implement)
- **[Part 8 — The cache in the Apollo Client pipeline](architecture/08-client-pipeline.md)**
  - [8.0 The call map](architecture/08-client-pipeline.md#80-the-call-map)
  - [8.1 Document transforms — what the cache sees is not what you wrote](architecture/08-client-pipeline.md#81-document-transforms--what-the-cache-sees-is-not-what-you-wrote)
  - [8.2 `ObservableQuery` — the cache's principal client](architecture/08-client-pipeline.md#82-observablequery--the-caches-principal-client)
  - [8.3 Fetch policies as a cache-interaction table](architecture/08-client-pipeline.md#83-fetch-policies-as-a-cache-interaction-table)
  - [8.4 `QueryInfo.markQueryResult` — the write path and the feud breaker](architecture/08-client-pipeline.md#84-queryinfomarkqueryresult--the-write-path-and-the-feud-breaker)
  - [8.5 Mutations — optimistic layer, final write, root-field scrub](architecture/08-client-pipeline.md#85-mutations--optimistic-layer-final-write-root-field-scrub)
  - [8.6 `refetchQueries` — the batch-and-collect protocol](architecture/08-client-pipeline.md#86-refetchqueries--the-batch-and-collect-protocol)
  - [8.7 Broadcast → notify → reobserve](architecture/08-client-pipeline.md#87-broadcast--notify--reobserve)
  - [8.8 Local state and `@client` fields](architecture/08-client-pipeline.md#88-local-state-and-client-fields)
  - [8.9 Data masking](architecture/08-client-pipeline.md#89-data-masking)
  - [8.10 `resetStore` and `clearStore`](architecture/08-client-pipeline.md#810-resetstore-and-clearstore)
  - [8.11 Memory internals — the cache's own telemetry](architecture/08-client-pipeline.md#811-memory-internals--the-caches-own-telemetry)
- **[Part 9 — Invariants and a re-implementation checklist](architecture/09-invariants-and-checklist.md)**
  - [9.1 The invariants](architecture/09-invariants-and-checklist.md#91-the-invariants)
  - [9.2 Build order for a re-implementation](architecture/09-invariants-and-checklist.md#92-build-order-for-a-re-implementation)
  - [9.3 Cross-boundary requirements](architecture/09-invariants-and-checklist.md#93-cross-boundary-requirements)
  - [9.4 The minimum viable surface](architecture/09-invariants-and-checklist.md#94-the-minimum-viable-surface)
  - [9.5 Where to look when something is wrong](architecture/09-invariants-and-checklist.md#95-where-to-look-when-something-is-wrong)

### [Performance guide](performance/README.md)

- **[Part 1 — The cost model in one page](performance/01-cost-model.md)**
  - [1.1 The four costs that matter](performance/01-cost-model.md#11-the-four-costs-that-matter)
  - [1.2 Headline complexity table](performance/01-cost-model.md#12-headline-complexity-table)
  - [1.3 Measured: the shape of the curves](performance/01-cost-model.md#13-measured-the-shape-of-the-curves)
  - [1.4 The one diagram to remember](performance/01-cost-model.md#14-the-one-diagram-to-remember)
- **[Part 2 — The write path](performance/02-write-path.md)**
  - [2.1 Where the time goes](performance/02-write-path.md#21-where-the-time-goes)
  - [2.2 The per-entity and per-field allocation budget](performance/02-write-path.md#22-the-per-entity-and-per-field-allocation-budget)
  - [2.3 The deep-equality tax](performance/02-write-path.md#23-the-deep-equality-tax)
  - [2.4 Field-key construction](performance/02-write-path.md#24-field-key-construction)
  - [2.5 Identity extraction](performance/02-write-path.md#25-identity-extraction)
  - [2.6 Merge functions](performance/02-write-path.md#26-merge-functions)
  - [2.7 Measured: write scaling](performance/02-write-path.md#27-measured-write-scaling)
- **[Part 3 — The read path](performance/03-read-path.md)**
  - [3.1 The memo graph *is* the read path](performance/03-read-path.md#31-the-memo-graph-is-the-read-path)
  - [3.2 The cost of a cold read](performance/03-read-path.md#32-the-cost-of-a-cold-read)
  - [3.3 Invalidation blast radius — the single most important read-path concept](performance/03-read-path.md#33-invalidation-blast-radius--the-single-most-important-read-path-concept)
  - [3.4 Structure sharing](performance/03-read-path.md#34-structure-sharing)
  - [3.5 Arrays](performance/03-read-path.md#35-arrays)
  - [3.6 The dev-build tax](performance/03-read-path.md#36-the-dev-build-tax)
- **[Part 4 — The dependency graph and broadcast](performance/04-dependency-graph-and-broadcast.md)**
  - [4.1 `depend` and `dirty`](performance/04-dependency-graph-and-broadcast.md#41-depend-and-dirty)
  - [4.2 Optimistic reads maintain a *second* set of memo entries](performance/04-dependency-graph-and-broadcast.md#42-optimistic-reads-maintain-a-second-set-of-memo-entries)
  - [4.3 The memo LRU cliff](performance/04-dependency-graph-and-broadcast.md#43-the-memo-lru-cliff)
  - [4.4 Broadcast fan-out](performance/04-dependency-graph-and-broadcast.md#44-broadcast-fan-out)
  - [4.5 Memo fragmentation by document identity](performance/04-dependency-graph-and-broadcast.md#45-memo-fragmentation-by-document-identity)
  - [4.6 Batching](performance/04-dependency-graph-and-broadcast.md#46-batching)
- **[Part 5 — Layers and optimistic updates](performance/05-layers-and-optimistic-updates.md)**
- **[Part 6 — Lifecycle operations](performance/06-lifecycle-operations.md)**
  - [6.1 `gc()` is `O(store)` unconditionally](performance/06-lifecycle-operations.md#61-gc-is-ostore-unconditionally)
  - [6.2 `evict` is cheap, its consequences are not](performance/06-lifecycle-operations.md#62-evict-is-cheap-its-consequences-are-not)
  - [6.3 `restore` versus `write`](performance/06-lifecycle-operations.md#63-restore-versus-write)
- **[Part 7 — Structural properties that stress the hot paths](performance/07-structural-stress.md)**
  - [7.0 The stress matrix](performance/07-structural-stress.md#70-the-stress-matrix)
  - [7.1 Depth (the worst offender)](performance/07-structural-stress.md#71-depth-the-worst-offender)
  - [7.2 Breadth](performance/07-structural-stress.md#72-breadth)
  - [7.3 Typed (normalized) versus untyped (embedded) data](performance/07-structural-stress.md#73-typed-normalized-versus-untyped-embedded-data)
  - [7.4 The untyped-blob pathology](performance/07-structural-stress.md#74-the-untyped-blob-pathology)
  - [7.5 Arrays of arrays](performance/07-structural-stress.md#75-arrays-of-arrays)
  - [7.6 Fan-in: many parents referencing one entity](performance/07-structural-stress.md#76-fan-in-many-parents-referencing-one-entity)
  - [7.7 Argument-heavy fields](performance/07-structural-stress.md#77-argument-heavy-fields)
  - [7.8 Polymorphism and fragments](performance/07-structural-stress.md#78-polymorphism-and-fragments)
  - [7.9 Repeated entities and cycles](performance/07-structural-stress.md#79-repeated-entities-and-cycles)
- **[Part 8 — Worst-case shapes and a stress corpus](performance/08-worst-case-shapes.md)**
  - [8.1 The four adversarial payloads](performance/08-worst-case-shapes.md#81-the-four-adversarial-payloads)
  - [8.2 A stress-test corpus for a re-implementation](performance/08-worst-case-shapes.md#82-a-stress-test-corpus-for-a-re-implementation)
- **[Part 9 — Optimization playbook](performance/09-optimization-playbook.md)**
  - [9.1 Decision tree](performance/09-optimization-playbook.md#91-decision-tree)
  - [9.2 Diagnostics](performance/09-optimization-playbook.md#92-diagnostics)
  - [9.3 Tuning knobs the cache actually exposes](performance/09-optimization-playbook.md#93-tuning-knobs-the-cache-actually-exposes)
  - [9.4 What a Rust/WASM re-implementation should target](performance/09-optimization-playbook.md#94-what-a-rustwasm-re-implementation-should-target)

<!-- toc:end -->

## Probes

Both probes import the installed `@apollo/client@4.2.11`. The repository's `patch-package`
patch only adds exports and does not change behaviour. Run `npm install` first, then run
the probes from the repository root.

**Behaviour probe:** [`probes/cache-behavior-probe.mjs`](probes/cache-behavior-probe.mjs).
It makes 78 assertions over the observable behaviour described in the architecture guide
and ends with `RESULT: all checks passed`.

```bash
node --conditions=development docs/probes/cache-behavior-probe.mjs
```

`--conditions=development` is required. Without it Node resolves the production build,
where result freezing and the data-loss warning are compiled out.

**Performance probe:** [`probes/cache-performance-probe.mjs`](probes/cache-performance-probe.mjs).
It produces every table in the performance guide. The committed output is
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

## Conventions

- **Source paths** are relative to `apollo-client-sm/src/`. Code snippets keep the source
  semantics but are condensed; the cited file has the exact text.
- **Section references** such as §2.4 are links. In the performance guide, a reference
  written "architecture §N.M" points into the architecture guide.
- **Diagrams** use one colour palette, explained in the
  [architecture legend](architecture/README.md#diagram-legend). They are written for
  GitHub's Mermaid renderer.
- **Navigation.** Every chapter has previous/next links at the top and bottom.
