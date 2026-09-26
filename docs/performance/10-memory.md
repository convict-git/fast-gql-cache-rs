# Part 10 — Memory

[Documentation](../README.md) › [Performance guide](README.md) · [← Part 9](09-optimization-playbook.md) · [Documentation home →](../README.md)

Parts 1–9 are about time. This part is about the other resource a cache spends: what
`InMemoryCache` keeps alive, and how much garbage it makes on the way. Every number comes
from the [memory probe](../probes/cache-memory-probe.mjs), whose output is committed at
[`probes/cache-memory-probe.log`](../probes/cache-memory-probe.log) (median of five runs,
each section in a fresh process; Node v24.21.0, darwin/arm64, production build). The
method, and the traps it avoids, are in [benchmarking.md](../benchmarking.md#memory).
A few facts were checked outside the probe; those are marked "verified".

Memory numbers are much steadier than timings: across the five runs, no measurement
moved by more than 2.5 %. The absolute sizes depend on V8's object layout, so a 32-bit or
pointer-compressed build would report smaller numbers. The ratios between the rows are
the result.

## 10.1 The memo is where the memory is

One list of `N` normalized entities (`F = 8`), cumulative (the probe's section 1):

| `N` | payload JSON | store after write | + a read (`optimistic: false`) | + a watch (`optimistic: true`) |
| --- | --- | --- | --- | --- |
| 1 000 | 149.6 KiB | 528.0 KiB | 4.67 MiB | 9.05 MiB |
| 5 000 | 778.6 KiB | 3.01 MiB | 23.71 MiB | 46.23 MiB |
| 20 000 | 3.13 MiB | 12.51 MiB | 95.78 MiB | 186.65 MiB |

The marginal cost per entity, from `N` = 1 000 to 20 000:

| Part | Bytes per entity | Against the store |
| --- | --: | --: |
| the payload, as JSON text | 165 | 0.25× |
| the store | 662 | 1× |
| the root read's memo | 4 366 | 6.6× |
| the optimistic watch's memo and last result | 4 774 | 7.2× |
| **a watched query, in total** | **9 800** | **14.8×** |

The normalized data is the small part. Result caching is almost 14 times larger than the
store it caches. Each memo entry is an `optimism` `Entry`, with its parent, child and dependency
sets and a dependency key string per field it read, plus the result object it holds.
Turning result caching off confirms the attribution (verified): with
`resultCaching: false` the same read retains 31 bytes per entity instead of 4 384.

The watch doubles it again. `ObservableQuery` watches with `optimistic: true`, and
optimistic reads never share the root's memo entries, even with no layer active
([§4.2](04-dependency-graph-and-broadcast.md#42-optimistic-reads-maintain-a-second-set-of-memo-entries)).
A query that is both watched and read with `readQuery` pays for both sets.

## 10.2 By shape

Store after write, then after one read (section 2):

| Shape | Payload JSON | Store | + read |
| --- | --- | --- | --- |
| normalized list (2 000 entities) | 306.9 KiB | 1.19 MiB | 9.54 MiB |
| embedded list (2 000 objects) | 290.4 KiB | 823.5 KiB | 4.34 MiB |
| deep chain (`D` = 256) | 19.1 KiB | 109.1 KiB | 1.03 MiB |
| nested lists (50 × 40 rows) | 101.9 KiB | 476.2 KiB | 6.24 MiB |
| scalar matrix (100 × 1 000 strings) | 858.6 KiB | 3.08 MiB | 4.03 MiB |
| JSON blob field (5 000 objects) | 232.7 KiB | 964.1 KiB | 1017.9 KiB |
| argument-heavy field (2 000 items) | 99.8 KiB | 495.1 KiB | 6.61 MiB |

- **Embedding halves the memo** (4.34 MiB against 9.54 MiB). Each embedded object still
  gets a memo entry, but reading it registers no dependencies: `getFieldValue` depends on
  a field only when it reads through a `Reference`
  ([architecture §2.2](../architecture/02-normalized-store.md#22-reading-a-field-through-the-chain)).
  An entity's eight fields each register a dependency key and its set, and the entity
  adds an `__exists` dependency and a `canRead` check. As in
  [§7.3](07-structural-stress.md#73-typed-normalized-versus-untyped-embedded-data), the
  price of embedding is invalidation granularity, not memory.
- **A JSON blob costs almost nothing to read** (+54 KiB for 5 000 objects). It has no
  selection set, so its objects are returned as stored. Only the top-level array is
  copied, because every non-empty list goes through `executeSubSelectedArray`
  ([§3.5](03-read-path.md#35-arrays)).
- **The scalar matrix is stored by reference**, so its "store" is mostly the caller's
  own arrays, which the cache adopts
  ([§7.5](07-structural-stress.md#75-arrays-of-arrays)). The read then copies every
  inner array.
- **Arguments are paid per entity.** An argument-heavy field's store key is a long
  string, repeated in every entity's store record and in every dependency key.

## 10.3 Allocation: what an operation throws away

Bytes allocated (JS heap), median of seven repetitions (section 3):

| Operation (`N` = 5 000) | Allocated | Per entity | Garbage collections |
| --- | --: | --: | --: |
| write cold | 91.92 MiB | 18.8 KiB | 2 |
| write of an identical payload | 88.42 MiB | 18.1 KiB | 1 |
| write with one field changed | 88.41 MiB | 18.1 KiB | 1 |
| read cold | 95.24 MiB | 19.5 KiB | 1 |
| read warm | 6.9 KiB | — | 0 |
| read after one dirty field | 7.22 MiB | 1.5 KiB | 0 |
| a one-field write broadcast to 50 watches | 134.14 MiB | — | 1 |
| 100 single-field writes in one `batch`, 1 watch | 15.71 MiB | — | 0 |

A cold write allocates 18.8 KiB per entity and keeps 662 bytes of it: **about 97 % of what
a write allocates is garbage**. That is the allocation budget of
[§2.2](02-write-path.md#22-the-per-entity-and-per-field-allocation-budget) measured.
Every other row repeats a timing result in bytes:

- An identical payload allocates as much as a new one, the "no fast path for a fresh
  payload" of [§2.7](02-write-path.md#27-measured-write-scaling).
- One dirty field re-walks the list, `O(N)`
  ([§3.3](03-read-path.md#33-invalidation-blast-radius--the-single-most-important-read-path-concept)).
- 50 watches add 45.7 MiB to a write they all see: one shared re-read, plus the equality
  gate's walk per watch ([§4.4](04-dependency-graph-and-broadcast.md#44-broadcast-fan-out)).

At `N` = 20 000 a cold write allocates 367 MiB, and the heap rose at least 106 MiB above
its starting size during it.

## 10.4 Bounded is not small

Every memo is a bounded LRU ([§4.3](04-dependency-graph-and-broadcast.md#43-the-memo-lru-cliff)),
but the bounds count **entries, not bytes**, and an entry holds a result of any size.
Two steady workloads that look harmless grow for a long time (section 5):

| Workload | Retained at the end | Trend |
| --- | --: | --- |
| rolling window: 5 live pages of 100, each page written, read, then evicted and collected | 30.91 MiB after 300 pages | grows 97 KiB per page |
| a freshly parsed document per read, over 1 000 entities | 530.40 MiB after 480 documents | grows 714 KiB per document |
| watch subscribe and unsubscribe | 7.11 MiB | flat |
| optimistic layer add and remove | 7.02 MiB | flat |

- **The rolling window keeps every evicted page's result.** Each page has its own
  variables, so its own root memo entry. Evicting the page's field dirties that entry but
  does not remove it, and a dirty entry keeps its last result, which references the
  page's 100 item results. The store stays at 501 entities, and yet memory grew to
  139 MiB after 1 500 pages (verified). `cache.gc({ resetResultCache: true })` brought it
  back to 0.5 MiB. The bound is the 50 000-entry LRU, so the ceiling is 50 000 pages'
  results.
- **Distinct documents fill the array memo.** Each document reads the list through its
  own `executeSubSelectedArray` entry, whose value is the whole list of item results. That
  LRU holds 10 000 entries, so its ceiling is 10 000 lists (verified: the
  `executeSelectionSet` memo stays at exactly 50 000 entries while memory keeps growing,
  and `resetResultCache` returns all of it). Applications that build documents at render
  time pay this on top of the fragmentation of
  [§4.5](04-dependency-graph-and-broadcast.md#45-memo-fragmentation-by-document-identity).

## 10.5 Reclamation

(Sections 4 and 6.)

- **Evict plus `gc()` returns less than half.** After unwatching, evicting and collecting
  a 5 000-entity list that was read and watched, 21.28 MiB of 46.44 MiB stays. The
  entities are gone, but the dirty root and list entries still hold their last results
  until the query is read again or the LRU evicts them. Collecting entities does not
  collect results.
- **Optimistic layers are cheap and fully returned.** Sixteen single-field layers under
  one watch take 240 KiB, and removing them returns all of it.
- **Dropping the cache returns everything.** Nothing outside the instance keeps its
  memory alive. Reactive variables, the `canonicalStringify` and `print` caches and
  graphql-tag's document cache are shared, but they hold keys and documents, not
  results.

## 10.6 What a re-implementation should target

Measured memory changes the order of [§9.4](09-optimization-playbook.md#94-what-a-rustwasm-re-implementation-should-target).
For memory, the store is the cheap part to replace, and the result memo is the expensive
part to keep:

1. **Memo bytes per entity**: 4.4 KiB per memo set, and a watched query holds two. A
   result representation that shares structure, and a dependency index that does not
   keep a string per field per entry, are where the savings are.
2. **Allocation per write**: 18.8 KiB per entity, about 97 % of it garbage. Arena allocation and
   bulk encoding cut both the garbage and the collections it causes.
3. **Bounds in bytes, and prompt release**: a stale result should not outlive its data.
   Evicting or collecting an entity should release the results that hold it, and a bound
   should be expressed in bytes.
4. **One memo for optimistic and root reads when no layer shadows the data.**

The memory probe is the oracle for all four: each corresponds to one of its rows or
checks, measured against `InMemoryCacheRs` on every benchmarked PR.

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Part 9 — Optimization playbook](09-optimization-playbook.md) | [Performance guide](README.md) | [Documentation home](../README.md) |
