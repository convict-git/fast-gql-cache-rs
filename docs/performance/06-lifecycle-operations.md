# Part 6 — Lifecycle operations

[Documentation](../README.md) › [Performance guide](README.md) · [← Part 5](05-layers-and-optimistic-updates.md) · [Part 7 →](07-structural-stress.md)

Over a store of `n` entities:

| `n` | evict entity | evict field | `gc()` collecting **nothing** | scale | `gc()` collecting `n` | scale | `extract()` | scale | `restore()` | scale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 000 | 22.1 µs | 20.7 µs | 1.03 ms | — | 3.91 ms | — | 175 µs | — | 1.54 ms | — |
| 5 000 | 21.1 µs | 21.7 µs | 5.16 ms | 1.00n | 19.93 ms | 1.02n | 1.20 ms | 1.38n | 8.89 ms | 1.15n |
| 20 000 | 22.5 µs | 23.2 µs | 27.41 ms | 1.33n | 83.55 ms | 1.05n | 6.04 ms | 1.25n | 37.66 ms | 1.06n |

Three results worth internalizing:

- **Eviction is flat** — ~22 µs whatever the store size. It touches one entity.
- **`gc()` costs `O(store)` even when it collects nothing** — 27.41 ms over a 20 000-entity
  store that is entirely reachable. A no-op `gc()` is not free; it is a full mark-and-sweep
  ([§6.1](#61-gc-is-ostore-unconditionally)). Collecting adds the per-entity deletion cost
  on top (83.55 ms when all 20 000 entities go).
- **`restore()` is ~4.8× cheaper than writing the same data** (37.66 ms against the
  182.46 ms cold write of [§2.7](02-write-path.md#27-measured-write-scaling), same list
  shape) because the snapshot is already normalized ([§6.3](#63-restore-versus-write)).

## 6.1 `gc()` is `O(store)` unconditionally

```ts
public gc() {
  const ids = this.getRootIdSet();
  const snapshot = this.toObject();
  ids.forEach((id) => {
    if (hasOwn.call(snapshot, id)) {
      Object.keys(this.findChildRefIds(id)).forEach(ids.add, ids);
      delete snapshot[id];
    }
  });
  const idsToRemove = Object.keys(snapshot);
  // ...
}
```

`toObject()` makes a shallow copy of the whole store, and `findChildRefIds` walks every
field of every reachable entity looking for `__ref`s. The per-entity result is memoized in
`this.refs[dataId]` and invalidated whenever that entity is merged — so a `gc()`
immediately after a large write re-walks everything that write touched. Putting it
together, with `R` the references held by reachable entities:

- `O(S)` for the copy and the sweep, **always**, even when nothing is collected;
- `O(R)` to follow the references when every reachable entity's memo is valid;
- plus `O(B)` for each reachable entity merged since its last walk, which is `O(S · F)`
  right after a write that touched every entity (the probe's `gc noop` column);
- plus `O(F)` to delete each collected entity (the `gc collect` column).

`InMemoryCache.gc()` runs on `optimisticData`, which is never the `Root` (it is the `Stump`
or the top layer, [§4.2](04-dependency-graph-and-broadcast.md#42-optimistic-reads-maintain-a-second-set-of-memo-entries)).
A layer's `toObject()` spreads its parent's copy into a new object, so the copy is made
once per store in the chain: two copies with no layers, `L + 2` with `L` layers. It also
empties the `canonicalStringify` and `print` caches.

There is no incremental mode. Do not call `gc()` on a timer; call it after bulk evictions.

`cache.gc({ resetResultCache: true })` additionally throws away `StoreReader`,
`StoreWriter`, `maybeBroadcastWatch` and both `CacheGroup` `keyMaker` Tries — that is a
memory reclamation tool, and it makes the **next** read of every query cold.

## 6.2 `evict` is cheap, its consequences are not

Evicting one entity is `O(F)` — `delete` routes through `modify` with a `DELETE` modifier
for every field, then dirties each removed field plus `__exists`. Evicting one field is
also `O(F)`, not `O(1)`: `modify` visits every field of the entity to find the ones whose
name matches. But every read that had a
dependency on it is now invalidated, and every list containing a reference to it must be
re-filtered by `canRead` on the next read ([§3.5](03-read-path.md#35-arrays)). The eviction is fast; the re-reads it
triggers are the cost.

One detail that matters with layers active: `InMemoryCache.evict` calls
`this.optimisticData.evict(options, this.data)`, and `EntityStore.evict` recurses to its
parent until it reaches that `limit`. So an evict walks the entire layer chain: `O(L)` to
visit the stores, plus `O(F)` in every store that holds the entity, `O(L · F)` at worst,
when optimistic layers are stacked. The `limit` argument is what
bounds the walk: normally `this.data` is the `Root`, so the eviction reaches all the way
down, but *during* an optimistic update `this.data` is temporarily the current `Layer`,
which stops the eviction at that layer. (It also means an eviction inside an optimistic
update only sees data stored in that layer, so evicting a `Root` entity there does nothing
— [architecture §2.8](../architecture/02-normalized-store.md#28-evict--deletion-across-the-layer-chain).)

## 6.3 `restore` versus `write`

`restore` is dramatically cheaper than writing the same data because the snapshot is
*already normalized*: there is no selection-set traversal, no `identify`, no
`getStoreFieldName`, and no merge functions. It is a `merge` per top-level `dataId`, and
into a fresh `Root` that merge adopts the snapshot's object as-is: the entity objects are
not copied (so the caller must not mutate or reuse the snapshot, and development reads
will freeze it). The remaining per-entity cost is the dirtying loop over its fields.

This is the argument for SSR hydration via `extract`/`restore` rather than replaying
queries.

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Part 5 — Layers and optimistic updates](05-layers-and-optimistic-updates.md) | [Performance guide](README.md) | [Part 7 — Structural properties that stress the hot paths](07-structural-stress.md) |
