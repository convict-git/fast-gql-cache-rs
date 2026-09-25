# Part 3 — The read path

[Documentation](../README.md) › [Performance guide](README.md) · [← Part 2](02-write-path.md) · [Part 4 →](04-dependency-graph-and-broadcast.md)

## 3.1 The memo graph *is* the read path

`StoreReader` wraps two functions with `optimism`'s `wrap` ([architecture §5.1](../architecture/05-store-reader.md#51-the-two-memoized-functions)):

```ts
this.executeSelectionSet = wrap((options) => { /* ... */ }, {
  max: cacheSizes["inMemoryCache.executeSelectionSet"] || defaultCacheSizes["inMemoryCache.executeSelectionSet"],
  keyArgs: execSelectionSetKeyArgs,
  makeCacheKey(selectionSet, parent, context) {
    if (supportsResultCaching(context.store)) {
      return context.store.makeCacheKey(selectionSet, isReference(parent) ? parent.__ref : parent, context.varString);
    }
  },
});
```

The memo key is `(selectionSetNode, dataId | object, varString)`, resolved through
`EntityStore.makeCacheKey` → `group.keyMaker.lookupArray(arguments)`, a three-level `Trie`
walk. Every (selection set, entity, variables) triple is one memo entry; an embedded object
is keyed by the stored object itself.

> This is why result caching is worth so much: a warm read is a handful of `Trie` node
> lookups, not a tree traversal.

Turning the memo graph off is the cleanest way to price it. Over 5 000 entities (the
probe's section 13):

| | `resultCaching: true` | `resultCaching: false` | ratio |
| --- | --- | --- | --- |
| warm read | 5.1 µs | 49.35 ms | **9618× slower** |
| write | 88.82 ms | 76.15 ms | 0.86× (14 % *cheaper*) |

Memoization is a read-path optimization **paid for on the write path** through dependency
bookkeeping: with `resultCaching: false` the store skips the dirtying loop in
`EntityStore.merge` entirely. The read-side win is thousands of times (the exact ratio is
noisy, because the numerator is a few microseconds); the write-side cost is a modest
constant factor. That trade is the central design decision of the whole cache, and it is
why `resultCaching: false` is a debugging tool rather than a tuning knob.

## 3.2 The cost of a cold read

`execSelectionSetImpl` per object (entity or embedded object):

```ts
const objectsToMerge: Record<string, any>[] = [];      // 1 array per object
const missingMerger = new DeepMerger();                // 1 merger per object, even when nothing is missing
const workSet = new Set(selectionSet.selections);      // 1 Set per object

workSet.forEach((selection) => {
  // ... per field:
  let fieldValue = policies.readField({ fieldName, field, variables, from: objectOrReference }, context);
  // ... recursion for object/array fields
  if (fieldValue !== void 0) {
    objectsToMerge.push({ [resultName]: fieldValue });  // 1 object per FIELD
  }
});

const result = mergeDeepArray(objectsToMerge);         // 1 more DeepMerger; one merge per field
const frozen = maybeDeepFreeze(finalResult);           // dev only: full recursive freeze
if (frozen.result) this.knownResults.set(frozen.result, selectionSet);
```

Per object read: **one `Set`, two `DeepMerger`s (the second only when there is more than
one field to merge), one array, `F` single-key objects**, plus `F` `readField` calls. Each
`readField` builds the field's store key (`O(A)` with arguments), reads the value, and
registers a dependency with `group.depend(dataId, storeFieldName)` — two with arguments
([§4.1](04-dependency-graph-and-broadcast.md#41-depend-and-dirty)). A `Reference` also
costs one `store.has` check, which registers an `__exists` dependency. So a cold read is
`O(F)` per object and `O(E · F)` in total; a repeated (entity, selection set) pair is a
memo hit after its first occurrence.

On an optimistic read (`optimistic: true`) every one of those lookups starts at the top of
the layer chain: `EntityStore.get` checks the store it was called on and, if that store
does not hold the field, calls its parent, registering a dependency at every level. With
`L` layers a field lookup costs up to `O(L)`, so a cold optimistic read is up to
`O(E · F · L)` ([Part 5](05-layers-and-optimistic-updates.md)).

The symmetry with the write path is not accidental — both are "traverse the selection set,
allocate one object per field, merge them". The difference is only that the reader's result
is memoized.

## 3.3 Invalidation blast radius — the single most important read-path concept

A read costs nothing when its memo entry is clean. So the real question is never "how big is
my query" but **"how much of my memo graph does a write invalidate?"**

```mermaid
flowchart TB
    subgraph tree["Memo entries form a tree that mirrors the result"]
        ROOT["ROOT_QUERY × QuerySelectionSet"]:::memo
        LIST["feed array entry<br/>(executeSubSelectedArray)"]:::memo
        E1["Item:i0 ×<br/>ItemSelectionSet"]:::memo
        E2["Item:i1 ×<br/>ItemSelectionSet"]:::memo
        E3["Item:i2 ×<br/>ItemSelectionSet"]:::memo
        EN["Item:iN ×<br/>ItemSelectionSet"]:::memo
        ROOT --> LIST
        LIST --> E1
        LIST --> E2
        LIST --> E3
        LIST --> EN
    end

    DIRTY["modify Item:i0.f0<br/>→ group.dirty('Item:i0', 'f0')"]:::dirty
    E1 <-.-|"invalidates"| DIRTY
    E1 -.->|"parent chain"| LIST
    LIST -.->|"parent chain"| ROOT

    RESULT["Re-read recomputes:<br/><b>E1 + LIST + ROOT</b> = 3 entries<br/>E2..EN are reused BY REFERENCE"]:::read
    DIRTY ~~~ RESULT

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

**Invalidation always propagates upward to the root**, never sideways:

| Change | Memo entries whose body re-executes |
| --- | --- |
| 1 field of 1 leaf entity in a flat list of `N` | `3` — the entity, the array, the root |
| 1 field of 1 entity at depth `D` | `D + 1` — the entity and its `D` ancestor entries |
| 1 field of `k` entities in a flat list | `k + 2` |
| a scalar field of `ROOT_QUERY` | `1` — the root entry; its child entries are memo hits |

(All four rows are counted by the probe or were verified by counting
`execSelectionSetImpl` and `execSubSelectedArrayImpl` calls.)

**Entries recomputed is not the same as work done.** Only three entries re-execute after a
point change in a list of `N`, but one of them is the array entry, and re-executing it
means a `filter` pass with `N` `canRead` calls plus an `N`-element `map` whose per-element
`executeSelectionSet` calls are memo *hits*. A memo hit is cheap — a three-level `Trie`
lookup, an `optimism` dirty check, and re-registering the child under its parent — but it
is not free, so the re-read is still `O(N)`.

In general, a re-executed entry costs its own fields, `O(F)`, plus one memo lookup per
child entry. On top of that, `optimism` 0.18.1 has a bookkeeping cost that depends on
*depth*. When a child entry registers as clean under a parent that is itself only
"dirty by child" (not dirty itself), the parent reports clean to *its* parent, and so on
up to the root. In a re-read every ancestor of the change is in that state, so each clean
child costs one step per level above it. An entry at depth `D` with `c` child entries
therefore costs `O(F + c · D)`:

- a list of `N` near the root costs `O(N)` (measured: `2N + 1` clean reports for a list at
  depth 1, against `N + 1` on a cold read);
- a chain of `D` nested entities costs `Σ d = O(D²)` (measured: exactly `D(D + 1) / 2`
  clean reports after a leaf change — 136 for `D = 16`, 2 080 for `D = 64` — against `D`
  on a cold read).

The counts come from an instrumented copy of `optimism` (verified, not in the probe). A
cold read does not pay the climb: new entries are dirty themselves, so a clean report
stops at the first parent.

`readQuery` over a list of `N` normalized entities (`F = 8`: `__typename`, `id` and six
scalar fields):

| `N` | cold | scale | warm | scale | after 1 dirty field | scale |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 2.88 ms | — | 4.5 µs | — | 362.8 µs | — |
| 1 000 | 28.95 ms | 1.01 | 3.8 µs | 0.09 | 2.99 ms | 0.83 |
| 5 000 | 155.23 ms | 1.07 | 3.8 µs | 0.20 | 19.53 ms | 1.30 |
| 20 000 | 701.99 ms | 1.13 | 3.6 µs | 0.24 | 93.03 ms | 1.19 |

Read the `after 1 dirty` column against `cold`: the cold read costs 7.9×, 9.7×, 7.9× and
7.5× the re-read at the four sizes, and both **scale the same way**. That factor is the
value of structure sharing; the linearity is the cost of the monolithic array entry.

Depth behaves completely differently. A single chain of `D` nested entities (three scalar
fields each; the leaf is at depth `D`), from the probe's section 4:

| `D` | write normalized | scale | write embedded | scale | read cold | scale | read warm | scale | **read after leaf change** | scale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 121.6 µs | — | 87.8 µs | — | 177.0 µs | — | 5.2 µs | — | 147.0 µs | — |
| 16 | 503.9 µs | 1.04 | 233.1 µs | 0.66 | 478.8 µs | 0.68 | 4.2 µs | 0.20 | 514.1 µs | 0.87 |
| 64 | 1.24 ms | 0.62 | 907.4 µs | 0.97 | 1.38 ms | 0.72 | 3.8 µs | 0.23 | 2.05 ms | 1.00 |
| 256 | 5.29 ms | 1.07 | 3.85 ms | 1.06 | 5.26 ms | 0.95 | 3.7 µs | 0.24 | 19.92 ms | 2.42 |
| 512 | 12.43 ms | 1.18 | 9.16 ms | 1.19 | 11.58 ms | 1.10 | 4.8 µs | 0.65 | **67.73 ms** | 1.70 |

Three things stand out.

- **The leaf-change re-read grows superlinearly in `D`, towards quadratic.** Its `scale`
  column climbs towards the step ratio (`4` for the 4× steps, `2` for the last 2× step)
  while `read cold` stays near `1.00`. Over `D` = 64 → 512 (8×) the re-read grows 33.0× —
  between linear (8×) and quadratic (64×), because the linear per-level work is still a
  large share at these depths — and the cold read 8.4×. The re-read re-executes exactly
  the `D + 1` entries on the path (the probe counts them), so the growth is not more
  entries: it is the per-level cost. Every ancestor has only a dirty *child*, and in
  optimism 0.18.1 such an entry reruns completely on the next read
  ([architecture §1.1](../architecture/01-foundations.md#entry--the-dependency-graph)); as
  each level finishes it reports clean to its parent, and that report climbs all the way
  to the root, so level `d` costs `O(d)` extra and the chain `O(D²)` (the counts are in
  the list above: `D(D + 1) / 2` clean reports, against `D` on a cold read).
- **The re-read overtakes the cold read of the entire chain.** It is 1.07× the cold read
  at `D = 16`, 1.49× at `D = 64` and 5.85× at `D = 512`. The memo graph is not merely
  useless in this shape — it is a net cost.
- **The write columns creep above `1.00` at the deepest rows.** That is the `O(D)` path
  copy per field of [§2.2](02-write-path.md#22-the-per-entity-and-per-field-allocation-budget),
  `O(F · D²)` for the chain; at these depths it is still a small effect next to the rest of
  the per-level work.

Note also that `read warm` stays at a few microseconds regardless of depth. Depth is free
when nothing changed and disproportionately expensive when something did.

So the rule is sharper than "depth is expensive":

> **Breadth costs a linear factor with a small constant. Depth costs a quadratic factor
> and, past a point, more than recomputing from scratch.** Point mutations at the bottom of
> deep normalized chains are the single worst shape for the read path.

## 3.4 Structure sharing

The reason breadth is cheap is that untouched subtrees are returned by reference. Modifying
one field of one entity in a list of 500 and comparing the previous result tree against the
new one:

```
identical (===) array elements reused: 499/500
top-level result object reused:        false
feed array reused:                     false
```

Every untouched element object comes back **by reference**. That is what keeps React
re-renders proportional to what actually changed, and it is also what makes the write
path's deep-equality tax ([§2.3](02-write-path.md#23-the-deep-equality-tax)) worth paying: `storeObjectReconciler` preserving
`existingValue` is what allows the reader's memo entries to survive.

Note what is *not* shared: the enclosing array. `executeSubSelectedArray` is one memo entry
for the whole array, so any element change rebuilds the array object (a shallow `map`) even
though every untouched element is reused. Consumers must therefore compare
element-by-element, not array-by-array — which is exactly what
`ObservableQuery`'s `equal(previousResult.data, diff.result)` does.

## 3.5 Arrays

`execSubSelectedArrayImpl` does two passes:

```ts
if (field.selectionSet) {
  array = array.filter((item) => item === undefined || context.store.canRead(item));
}
array = array.map((item, i) => { /* recurse */ });
```

- **`filter` allocates a second array** and calls `canRead` per element. `canRead` on a
  `Reference` is `store.has(__ref)`, which walks the layer chain until a store holds the
  entity (`O(L)` on an optimistic read) and registers an `__exists` dependency. So an
  `N`-element list of references registers `N` extra dependencies beyond the per-field
  ones.
- **`map` allocates a third array.** For a list of references with a sub-selection, each
  element then goes through `executeSelectionSet` (memoized).
- **Every non-empty list goes through `executeSubSelectedArray`**, including a list of
  scalars with no sub-selection: it is `map`ped into a new array, so a cold read of such a
  list is `O(N)`, not a property lookup ([§7.5](07-structural-stress.md#75-arrays-of-arrays)).
- **Nested arrays recurse into `executeSubSelectedArray`**, each level being its own memo
  entry keyed by `(fieldNode, arrayObject, varString)`. The key is the **array instance
  stored in the cache**. When a write replaces the outer array, its inner arrays are new
  objects too, so every inner array entry misses.

The probe's shape here is not an array of arrays but a list of `G` group entities, each
with a list field of `R` row entities (`G × R` rows in total):

| `G × R` | write | scale | read cold | scale | read warm | scale | 1 row dirty | scale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 × 10 | 1.60 ms | — | 2.16 ms | — | 4.5 µs | — | 155.5 µs | — |
| 10 × 100 | 9.26 ms | 0.58 | 15.13 ms | 0.70 | 4.0 µs | 0.09 | 586.7 µs | 0.38 |
| 100 × 100 | 93.29 ms | 1.01 | 178.93 ms | 1.18 | 4.1 µs | 0.10 | 1.21 ms | 0.21 |
| 100 × 500 | 500.60 ms | 1.07 | 1.02 s | 1.14 | **4.60 ms** | **224.02** | 4.74 ms | 0.78 |

Write and cold read grow linearly with the total row count once the fixed cost of the
smallest shape is amortized (their first step reads below `1.00`). The `1 row dirty`
column does not: changing one row re-executes the row, `g0`'s rows array, `g0`, the groups
array and the root, and re-walks both arrays with memo hits, so it costs `O(G + R)`, not
`O(G · R)`; its `scale` column, computed against `G × R`, reads below `1.00` (the last row
also carries the LRU cliff described next).

The exception is one cell. The `100 × 500` warm read is **three orders of magnitude**
slower than every other warm read (4.60 ms against 4.1 µs for `100 × 100`), and its scale
column reads `224.02`.

That is not an array-nesting effect. `100 × 500` rows + 100 groups + `ROOT_QUERY` = 50 101
entities, just over the 50 000 `executeSelectionSet` limit — so the LRU trim that follows
every read evicts entries this query needs, and the next "warm" read recomputes them. This
is the LRU cliff of [§4.3](04-dependency-graph-and-broadcast.md#43-the-memo-lru-cliff),
reached by accident from a shape that looks entirely unremarkable. It is the single best
argument for checking memo sizes before blaming the cache.

## 3.6 The dev-build tax

Same 5 000-entity shape, production build against development build, each measured in a
fresh process that runs only this comparison (the probe's section 14):

| | production | development | ratio |
| --- | --- | --- | --- |
| write | 87.22 ms | 99.00 ms | 1.14× |
| read cold | 155.42 ms | 180.54 ms | 1.16× |
| results frozen | `false` | `true` | — |

`maybeDeepFreeze` walks every returned object recursively, and `getFieldValue` calls it on
every field value read out of the store:

```ts
public getFieldValue = <T = StoreValue>(objectOrReference, storeFieldName) =>
  maybeDeepFreeze(
    isReference(objectOrReference) ? this.get(objectOrReference.__ref, storeFieldName)
    : objectOrReference && objectOrReference[storeFieldName]
  ) as SafeReadonly<T>;
```

It does **not** short-circuit on already-frozen objects: `deepFreeze` skips re-freezing a
frozen object but still walks all of its children. Every recomputed level therefore walks
its whole result subtree, including children reused from the memo, and every
`getFieldValue` walks the stored value it returns. After one field changes in a
1 000-item list, a development re-read walks about 2 000 objects (verified: 2 006): the new
result tree plus the stored list of references. The tax is proportional to the size of
what is recomputed and read, not just to what is new.

Because every recomputed entry walks its whole subtree, the tax also grows with depth. On
a cold read, each of the `D` entries of a chain freezes everything below it, so a
development read of a chain of `D` entities walks `O(D²)` objects (verified: 186, 626 and
2 274 objects for `D` = 16, 32 and 64), where the production read is `O(D)`. Never profile
the development build.

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Part 2 — The write path](02-write-path.md) | [Performance guide](README.md) | [Part 4 — The dependency graph and broadcast](04-dependency-graph-and-broadcast.md) |
