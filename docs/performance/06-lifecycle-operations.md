# Part 6 — Lifecycle operations

[Documentation](../README.md) › [Performance guide](README.md) · [← Part 5](05-layers-and-optimistic-updates.md) · [Part 7 →](07-structural-stress.md)

Over a list of `N` entities, so a store of `S = N + 1` entries (the probe's section 12):

| `N` | evict entity | evict field | `gc()` collecting **nothing**, right after a write | scale | `gc()` collecting nothing, again | scale | `gc()` collecting `N` | scale | `extract()` | scale | `restore()` | scale | `writeQuery` of the same list |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 000 | 58.5 µs | 45.3 µs | 1.38 ms | — | 263.6 µs | — | 6.66 ms | — | 456.2 µs | — | 3.21 ms | — | 17.83 ms |
| 5 000 | 43.2 µs | 39.1 µs | 10.98 ms | 1.59 | 5.54 ms | 4.20 | 38.47 ms | 1.15 | 2.03 ms | 0.89 | 15.71 ms | 0.98 | 86.69 ms |
| 20 000 | 55.1 µs | 55.9 µs | 55.80 ms | 1.27 | 29.68 ms | 1.34 | 169.58 ms | 1.10 | 10.62 ms | 1.30 | 66.55 ms | 1.06 | 365.65 ms |

Three results worth internalizing:

- **Eviction is flat** — 58.5 µs, 43.2 µs and 55.1 µs for the three store sizes. It
  touches one entity, `O(F)`.
- **`gc()` costs `O(S)` even when it collects nothing** — 55.80 ms
  over a 20 000-entity store that is entirely reachable, measured right after the write that
  created it, so every entity's child-reference memo is cold and every field is walked. A
  second `gc()` reuses those memos and still costs 29.68 ms:
  the store copy and the sweep remain. A no-op `gc()` is not free; it is a full
  mark-and-sweep ([§6.1](#61-gc-is-ostore-unconditionally)). Collecting adds the per-entity
  deletion cost on top (169.58 ms when all 20 000 entities go).
- **`restore()` is 5.5× cheaper than writing the same data** (66.55 ms against 365.65 ms
  at `N = 20 000`, both measured in the same process) because the snapshot is already
  normalized ([§6.3](#63-restore-versus-write)).

`extract()` is `O(S)` — one shallow copy of the entity map, plus sorting the extra
retained root ids for `__META` — and `restore()` is `O(S · F)`.

Several `scale` values in the table sit above `1.00` although every operation in it is
linear in `S` by the code: most of all the two no-op `gc()` columns (1.59 and 4.20 for the
1 000 → 5 000 step). The probe does not isolate why. Read them as linear work whose
per-entity cost rises as the store grows, not as a superlinear algorithm.

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
name matches. But every read that had a dependency on it is now invalidated, and every
list containing a reference to it must be re-filtered by `canRead` on the next read
([§3.5](03-read-path.md#35-arrays)). The eviction is fast; the re-reads it triggers are
the cost.

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
