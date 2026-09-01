# Apollo Client `InMemoryCache` — Maintainer's Deep Dive

> **Source of truth.** Everything below is derived from the `apollo-client-sm` submodule,
> pinned at `ba511be` (`@apollo/client@4.2.11`). Paths are relative to
> `apollo-client-sm/src/`. Snippets are verbatim; where a snippet is abbreviated it is
> marked with `// ...`.
>
> **Companion documents.**
> [`apollo-client-inmemory-cache-performance.md`](./apollo-client-inmemory-cache-performance.md)
> covers the cost model of every path described here.
> [`probes/cache-behavior-probe.mjs`](./probes/cache-behavior-probe.mjs) is an executable
> oracle: 78 assertions that pin the observable behaviour documented below.
> Run it with `node --conditions=development docs/probes/cache-behavior-probe.mjs`.

---

## How to read this document

The document is **topologically ordered**: nothing is explained before its dependencies.

| Part | Contents | Depends on |
| --- | --- | --- |
| [0](#part-0--orientation) | Orientation: mental model, file map, vocabulary | — |
| [1](#part-1--foundations) | Foundations: `optimism`, `Trie`, LRU caches, `DeepMerger`, `canonicalStringify` | — |
| [2](#part-2--the-normalized-store) | `EntityStore`, `Root`/`Stump`/`Layer`, `CacheGroup` | 1 |
| [3](#part-3--policies) | `Policies`: identity, field keys, read/merge functions, `fragmentMatches` | 1, 2 |
| [4](#part-4--storewriter) | `StoreWriter`: the write path | 1, 2, 3 |
| [5](#part-5--storereader) | `StoreReader`: the read path | 1, 2, 3 |
| [6](#part-6--reactivity) | Watches, broadcast, transactions, optimistic layers, reactive vars | 2, 4, 5 |
| [7](#part-7--method-by-method-reference) | Every `ApolloCache` method as implemented by `InMemoryCache` | 2–6 |
| [8](#part-8--the-cache-in-the-apollo-client-pipeline) | The cache in the wider client | 7 |
| [9](#part-9--invariants-and-a-re-implementation-checklist) | Invariants and a re-implementation checklist | all |

### Diagram legend

Every diagram uses one palette. Learn it once:

```mermaid
flowchart LR
    A["Public API<br/>what callers invoke"]:::api
    B["Read path"]:::read
    C["Write path"]:::write
    D["Normalized storage<br/>data at rest"]:::store
    E["Memoization &amp;<br/>dependency tracking"]:::memo
    F["Invalidation, eviction,<br/>errors"]:::dirty
    G["Code outside<br/>the cache"]:::ext

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

Arrow conventions: a **solid arrow** is a synchronous call or a data hand-off; a
**dotted arrow** is a dependency registration or an invalidation signal.

---

## Part 0 — Orientation

### 0.1 The one-paragraph mental model

`InMemoryCache` is a **normalizing, dependency-tracking, layered document store for GraphQL
results**. Writes shred a response tree into a flat map of entities keyed by a stable
identity (`Todo:3`), replacing every identifiable child object with a `{ __ref }` pointer.
Reads walk a GraphQL selection set over that flat map and re-assemble a response-shaped
tree, memoizing every subtree keyed by `(selectionSet, parentEntity, variables)` and
recording exactly which `(entityId, fieldName)` pairs each memoized subtree consumed.
When a write changes a field, only the memoized subtrees that recorded a dependency on
that field are invalidated, so re-reading is proportional to what actually changed rather
than to the size of the query. Optimistic updates are a linked list of copy-on-write
layers stacked above the durable root, so they can be rolled back without touching
server data.

The [Demystifying Cache Normalization](https://www.apollographql.com/blog/demystifying-cache-normalization)
blog post describes the first sentence. This document covers the rest — the parts that
make the cache fast, reactive, and transactional.

### 0.2 The blog's example, as the cache actually stores it

The blog says the cache "splits results into objects, assigns identifiers, and stores them
flat". Here is the literal `cache.extract()` output for its `GetAllTodos` example, taken
from [section 1 of the probe](./probes/cache-behavior-probe.mjs):

```jsonc
{
  "Todo:1": { "__typename": "Todo", "id": 1, "text": "First todo",  "completed": true  },
  "Todo:2": { "__typename": "Todo", "id": 2, "text": "Second todo", "completed": false },
  "Todo:3": { "__typename": "Todo", "id": 3, "text": "Third todo",  "completed": false },
  "ROOT_QUERY": {
    "__typename": "Query",
    "todos": [{ "__ref": "Todo:1" }, { "__ref": "Todo:2" }, { "__ref": "Todo:3" }]
  }
}
```

And after the blog's `EditTodo` mutation, the mutation root records the operation under an
**argument-encoded field key**, while `Todo:3` is merged in place:

```jsonc
{
  "ROOT_MUTATION": {
    "__typename": "Mutation",
    "editTodo({\"id\":3,\"text\":\"Best todo\"})": {
      "__typename": "EditTodoResponse",
      "todo": { "__ref": "Todo:3" }
    }
  },
  "Todo:3": { "__typename": "Todo", "id": 3, "text": "Best todo", "completed": false }
}
```

Three things the blog does not mention are already visible here, and each is load-bearing
for the rest of this document:

1. `editTodo(...)` is a **`storeFieldName`**, not a field name. Arguments are serialised
   into the key by `canonicalStringify` so that key order in variables cannot produce two
   different entries for the same logical field ([§3.3](#33-field-identity-getstorefieldname)).
2. `EditTodoResponse` has no `id`, so it is **not** normalized. It is stored inline inside
   `ROOT_MUTATION` as a nested `StoreObject`. Only identifiable objects get hoisted
   ([§3.2](#32-entity-identity-policiesidentify)).
3. Every write **retains** the root id it wrote to, which is what keeps entities alive
   through garbage collection ([§2.9](#29-garbage-collection)).

### 0.3 File map

```mermaid
flowchart TB
    subgraph core["cache/core — cache-agnostic contract"]
        CACHE["cache.ts<br/><b>ApolloCache</b> abstract base<br/>readQuery / writeQuery / readFragment /<br/>writeFragment / updateQuery / watchFragment"]:::api
        CTYPES["types/Cache.ts<br/>ReadOptions, WriteOptions, DiffOptions,<br/>WatchOptions, BatchOptions, DiffResult"]:::api
        COMMON["types/common.ts<br/>MissingFieldError, Modifier,<br/>ReadFieldOptions, SafeReadonly"]:::api
    end

    subgraph inmem["cache/inmemory — the InMemoryCache implementation"]
        IMC["inMemoryCache.ts<br/><b>InMemoryCache</b><br/>orchestration, watches, batch, gc"]:::api
        ES["entityStore.ts<br/><b>EntityStore</b> / Root / Stump / Layer<br/><b>CacheGroup</b> dependency tracking"]:::store
        POL["policies.ts<br/><b>Policies</b><br/>identify, getStoreFieldName,<br/>readField, merge fns, fragmentMatches"]:::write
        KEX["key-extractor.ts<br/>keyFields / keyArgs specifier compilers"]:::write
        RD["readFromStore.ts<br/><b>StoreReader</b><br/>diffQueryAgainstStore,<br/>executeSelectionSet"]:::read
        WR["writeToStore.ts<br/><b>StoreWriter</b><br/>writeToStore,<br/>processSelectionSet"]:::write
        RV["reactiveVars.ts<br/>makeVar, cacheSlot,<br/>forgetCache / recallCache"]:::memo
        FR["fragmentRegistry.ts<br/>named-fragment registry"]:::ext
        HLP["helpers.ts<br/>defaultDataIdFromObject,<br/>fieldNameFromStoreName"]:::ext
        TY["types.ts<br/>NormalizedCache, NormalizedCacheObject,<br/>MergeTree, ReadMergeModifyContext"]:::ext
    end

    CACHE --> IMC
    IMC --> ES
    IMC --> POL
    IMC --> RD
    IMC --> WR
    IMC --> RV
    IMC --> FR
    POL --> KEX
    POL --> HLP
    RD --> ES
    RD --> POL
    WR --> ES
    WR --> POL
    WR -.->|"isFresh short-circuit"| RD
    RV -.->|"dirty + broadcast"| IMC

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

| File | Lines | Responsibility |
| --- | ---: | --- |
| `cache/core/cache.ts` | 934 | The `ApolloCache` contract plus the concrete convenience layer (`readQuery`, `writeFragment`, `updateQuery`, `watchFragment`) that every cache inherits. |
| `cache/core/types/Cache.ts` | 410 | Option and result types for the abstract methods. |
| `cache/core/types/common.ts` | 135 | `MissingFieldError`, `Modifier`, `ReadFieldOptions`. |
| `cache/inmemory/inMemoryCache.ts` | 610 | Orchestration only. Holds `data`/`optimisticData`, the watch set, `txCount`, and the `maybeBroadcastWatch` memoizer. Delegates all real work. |
| `cache/inmemory/entityStore.ts` | 883 | The normalized store, the layer chain, and the dependency graph. |
| `cache/inmemory/policies.ts` | 1216 | Every configuration-driven decision: identity, field keys, read/merge functions, fragment matching. |
| `cache/inmemory/key-extractor.ts` | 270 | Compiles `keyFields`/`keyArgs` specifier arrays into functions. |
| `cache/inmemory/readFromStore.ts` | 507 | The memoized read path. |
| `cache/inmemory/writeToStore.ts` | 967 | The two-phase write path. |
| `cache/inmemory/reactiveVars.ts` | 123 | `makeVar` and the cache↔variable attachment registry. |
| `cache/inmemory/fragmentRegistry.ts` | 179 | Optional registry so documents can reference fragments they don't declare. |
| `cache/inmemory/helpers.ts` | 151 | Small shared predicates and the default id function. |

### 0.4 Vocabulary

These terms are used with precision throughout. Confusing `fieldName` with
`storeFieldName`, or `dataId` with `Reference`, makes the rest of the code unreadable.

| Term | Type | Definition | Example |
| --- | --- | --- | --- |
| **`dataId`** | `string` | The cache-wide unique key of an entity. Produced by `Policies.identify`. | `"Todo:3"`, `"ROOT_QUERY"` |
| **`Reference`** | `{ __ref: string }` | A pointer to a `dataId`. The only way one entity refers to another. | `{ __ref: "Todo:3" }` |
| **`StoreObject`** | `Record<string, StoreValue>` | The flat, per-entity record. Values are scalars, `Reference`s, arrays, or nested non-normalized objects. | `{ __typename: "Todo", id: 3, text: "…" }` |
| **`StoreValue`** | union | Anything storable in a `StoreObject` field. | `3`, `{ __ref }`, `[{ __ref }]` |
| **`NormalizedCacheObject`** | `Record<dataId, StoreObject>` | The whole serializable store, plus an optional `__META`. | see §0.2 |
| **`fieldName`** | `string` | The GraphQL field name, without arguments. | `"feed"` |
| **`storeFieldName`** | `string` | The key actually used inside a `StoreObject`: `fieldName` plus a serialised argument/key suffix. | `feed({"type":"top"})` |
| **`resultKeyName`** | `string` | The key used in the *result* object — the alias if present, otherwise `fieldName`. Never appears in the store. | `"topFeed"` for `topFeed: feed(...)` |
| **`selectionSet`** | AST node | A `SelectionSetNode`. Used as an identity-comparable memoization key, so AST stability matters. | — |
| **`varString`** | `string` | `canonicalStringify(variables)`. Part of every read memo key. | `'{"limit":10}'` |
| **`layer`** | `EntityStore` | One copy-on-write frame of optimistic data. | — |
| **`CacheGroup`** | class | The dependency-tracking scope. Exactly two exist per cache: root and optimistic. | — |
| **`dep key`** | `string` | `storeFieldName + "#" + dataId` — the atom of the dependency graph. | `text#Todo:3` |

### 0.5 The whole machine in one diagram

```mermaid
flowchart TB
    subgraph client["Apollo Client (outside the cache)"]
        direction LR
        AC["ApolloClient<br/>readQuery / writeQuery /<br/>watchFragment / extract"]:::ext
        QM["QueryManager<br/>transformDocument, refetchQueries,<br/>fetch policies"]:::ext
        OQ["ObservableQuery<br/>cache.watch + cache.diff"]:::ext
        QI["QueryInfo<br/>markQueryResult /<br/>markMutationResult"]:::ext
    end

    subgraph api["InMemoryCache — public surface"]
        direction LR
        W["write / writeQuery /<br/>writeFragment"]:::api
        R["read / readQuery /<br/>readFragment / diff"]:::api
        WATCH["watch / watchFragment"]:::api
        MUT["modify / evict / gc /<br/>batch / removeOptimistic"]:::api
    end

    subgraph engine["Engine"]
        direction TB
        SW["<b>StoreWriter</b><br/>processSelectionSet →<br/>MergeTree → applyMerges"]:::write
        SR["<b>StoreReader</b><br/>executeSelectionSet<br/>(memoized)"]:::read
        P["<b>Policies</b><br/>identify · getStoreFieldName ·<br/>readField · merge · fragmentMatches"]:::write
    end

    subgraph storage["Storage &amp; reactivity"]
        direction TB
        OD["optimisticData<br/>Layer → … → Stump"]:::store
        D["data<br/>EntityStore.Root<br/>NormalizedCacheObject"]:::store
        CG["CacheGroup<br/>dep(fieldName#dataId)<br/>keyMaker: Trie"]:::memo
        MBW["maybeBroadcastWatch<br/>optimism wrap, LRU 5000"]:::memo
    end

    AC --> W & R & WATCH & MUT
    QM --> QI --> W
    OQ --> WATCH
    OQ --> R

    W --> SW --> P
    R --> SR --> P
    SW -->|"store.merge"| D
    SW -.->|"group.dirty"| CG
    SR -->|"store.get"| D
    SR -.->|"group.depend"| CG
    OD -->|"parent chain"| D
    MUT --> OD

    CG -.->|"invalidate memo entries"| SR
    CG -.->|"invalidate"| MBW
    WATCH --> MBW --> SR
    MBW -->|"diff changed → callback"| OQ

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

The single most important structural fact in that diagram is the **dotted triangle**:
`StoreReader` *registers* dependencies in the `CacheGroup` while reading, `StoreWriter`
*dirties* them while writing, and the `CacheGroup` *invalidates* memoized read results and
watch broadcasts. Everything else is plumbing around that loop.

---

## Part 1 — Foundations

The cache is built on five small primitives. None of them are GraphQL-aware, and all of
them are load-bearing for correctness — not just performance. Re-implementing the cache
without equivalents for these is not possible.

```mermaid
flowchart TB
    subgraph prims["Foundation primitives"]
        OPT["<b>optimism</b><br/>wrap() · Entry · dep() · Slot"]:::memo
        TRIE["<b>@wry/trie</b><br/>Trie&lt;Data&gt;<br/>tuple → stable object"]:::memo
        LRU["<b>@wry/caches</b><br/>StrongCache / WeakCache<br/>doubly-linked LRU"]:::memo
        EQ["<b>@wry/equality</b><br/>equal(a, b)<br/>cycle-tolerant deep equality"]:::read
        DM["<b>DeepMerger</b><br/>structure-sharing deep merge"]:::write
        CS["<b>canonicalStringify</b><br/>key-sorted JSON"]:::write
        FRZ["<b>maybeDeepFreeze</b><br/>Object.freeze in __DEV__"]:::read
    end

    OPT --> TRIE
    OPT --> LRU
    CS --> LRU

    subgraph uses["Where each is used"]
        U1["StoreReader.executeSelectionSet<br/>InMemoryCache.maybeBroadcastWatch<br/>ApolloCache.getFragmentDoc"]:::read
        U2["CacheGroup.keyMaker<br/>Root.storageTrie<br/>ApolloCache.fragmentWatches<br/>flattenFields limitingTrie"]:::store
        U3["CacheGroup.d = dep()<br/>reactive-var dep"]:::memo
        U4["broadcastWatch result gate<br/>storeObjectReconciler<br/>Layer.removeLayer dirtying"]:::dirty
        U5["StoreReader.mergeDeepArray<br/>StoreWriter context.merge<br/>missing-tree accumulation"]:::write
        U6["storeFieldName args<br/>varString<br/>keyFields JSON"]:::write
    end

    OPT --> U1
    OPT --> U3
    TRIE --> U2
    EQ --> U4
    DM --> U5
    CS --> U6

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

### 1.1 `optimism` — memoization with automatic dependency tracking

`optimism@0.18.1` provides the reactive core. Two exports matter.

#### `wrap(fn, options)` → memoized function

`wrap` returns a function that caches results in an LRU keyed by
`makeCacheKey(keyArgs(...args))`. The crucial difference from ordinary memoization is that
each cached result is an **`Entry` node in a bipartite dependency graph**, and entries
recompute lazily when anything they read has been marked dirty.

```ts
// node_modules/optimism/src/index.ts
const optimistic = function (): TResult {
  const key = makeCacheKey.apply(null, keyArgs ? keyArgs.apply(null, arguments) : arguments);
  if (key === void 0) {
    return originalFunction.apply(null, arguments);   // memoization opted out
  }
  let entry = cache.get(key)!;
  if (!entry) {
    cache.set(key, entry = new Entry(originalFunction));
    // ...
  }
  const value = entry.recompute(Array.prototype.slice.call(arguments) as TArgs);
  cache.set(key, entry);                              // LRU: move to front
  // ...
  return value;
};
```

Note the first branch: **returning `undefined` from `makeCacheKey` disables memoization for
that call**. The cache uses this deliberately — `StoreReader`'s `makeCacheKey` returns
`undefined` when `supportsResultCaching(context.store)` is false, which is how
`resultCaching: false` is implemented without a second code path.

#### `Entry` — the dependency graph

```ts
// node_modules/optimism/src/entry.ts
export class Entry<TArgs extends any[], TValue> {
  public readonly parents = new Set<AnyEntry>();
  public readonly childValues = new Map<AnyEntry, Value<any>>();
  public dirtyChildren: Set<AnyEntry> | null = null;
  public dirty = true;
  public readonly value: Value<TValue> = [];

  public recompute(args: TArgs): TValue {
    assert(! this.recomputing, "already recomputing");
    rememberParent(this);
    return mightBeDirty(this) ? reallyRecompute(this, args) : valueGet(this.value);
  }
}
```

The mechanics that matter for the cache:

- **`parentEntrySlot`** is a dynamically-scoped variable holding the entry currently being
  recomputed. `rememberParent(child)` reads it, so any `wrap`ped call made *inside* another
  `wrap`ped call automatically becomes its child. **No explicit dependency wiring exists
  anywhere in the cache** — nesting is the wiring.
- **`setDirty()`** flips `dirty` and propagates *upward only* via `reportDirtyChild`,
  which returns early once a parent already knows it has a dirty child. Marking is
  therefore near-`O(1)` amortised, and recomputation is deferred to the next read.
- **`reportCleanChild`** is the subtle part. When a dirty child recomputes to a value that
  is `===` its previously recorded value, the parent is *not* dirtied:

  ```ts
  const childValue = parent.childValues.get(child)!;
  if (childValue.length === 0) {
    parent.childValues.set(child, valueCopy(child.value));
  } else if (! valueIs(childValue, child.value)) {
    parent.setDirty();
  }
  ```

  This is why a write that produces a deeply-equal value stops propagating at the first
  memoized frame instead of invalidating everything above it — and why
  `storeObjectReconciler` ([§2.6](#26-writes-merge-and-storeobjectreconciler)) works so
  hard to preserve `===`.

#### `dep()` — dependency leaves

```ts
// node_modules/optimism/src/dep.ts
export function dep<TKey>(options?: { subscribe: Dep<TKey>["subscribe"] }) {
  const depsByKey = new Map<TKey, Dep<TKey>>();
  function depend(key: TKey) {
    const parent = parentEntrySlot.getValue();
    if (parent) {
      let dep = depsByKey.get(key);
      if (!dep) depsByKey.set(key, dep = new Set as Dep<TKey>);
      parent.dependOn(dep);
      // ...
    }
  }
  depend.dirty = function dirty(key: TKey, entryMethodName?: EntryMethodName) {
    const dep = depsByKey.get(key);
    if (dep) {
      const m = (entryMethodName && hasOwnProperty.call(EntryMethods, entryMethodName))
        ? entryMethodName : "setDirty";
      arrayFromSet(dep).forEach(entry => entry[m]());
      depsByKey.delete(key);
      maybeUnsubscribe(dep);
    }
  };
  return depend as OptimisticDependencyFunction<TKey>;
}
```

A `dep` is a leaf in the graph: it has parents but no value and no children. `CacheGroup`
owns exactly one `dep` instance and uses field-level string keys
([§2.4](#24-cachegroup--the-dependency-graph)).

`dirty(key, method)` supports three escalation levels, all used by the cache:

| Method | Effect | Used for |
| --- | --- | --- |
| `setDirty` (default) | Mark entries stale; they stay in the LRU and keep their edges. | Ordinary field changes. |
| `dispose` | Detach the entry from parents/children but leave it in the LRU. | not used by the cache |
| `forget` | Fully remove the entry from the LRU and the graph. | `__exists` dirtying — see [§2.4](#24-cachegroup--the-dependency-graph). |

`depsByKey.delete(key)` after dirtying means dependency sets are **rebuilt on the next
read**, so the graph stays proportional to what is currently being observed.

#### `Slot` — dynamic scoping

`cacheSlot` ([§6.6](#66-reactive-variables)) and `parentEntrySlot` are `Slot` instances.
`slot.withValue(v, fn, args)` runs `fn` with `slot.getValue() === v`, restoring the
previous value afterwards. This is how a `read` function invoked several frames deep
inside `executeSelectionSet` can discover which cache it belongs to without threading it
through every signature.

### 1.2 `@wry/trie` — tuples as stable object identities

```ts
// node_modules/@wry/trie/src/index.ts
export class Trie<Data> {
  private weak?: WeakMap<any, Trie<Data>>;
  private strong?: Map<any, Trie<Data>>;
  private data?: Data;
  constructor(private weakness = true, private makeData: (array: any[]) => Data = defaultMakeData) {}

  public lookupArray<T extends IArguments | any[]>(array: T): Data {
    let node: Trie<Data> = this;
    forEach.call(array, key => node = node.getChildTrie(key));
    return hasOwnProperty.call(node, "data") ? node.data as Data : node.data = this.makeData(slice.call(array));
  }
}
```

`trie.lookupArray([a, b, c])` returns the *same object* every time it is called with the
same three values, comparing them by `===`. Object keys are held in a `WeakMap` (when
`weakness` is on) and primitives in a `Map`, so a trie can mix both.

This turns an argument tuple into a single identity usable as a `Map` key, which is what
makes `optimism` cache keys cheap. Five tries exist in the cache:

| Trie | Owner | Key tuple | Weak? |
| --- | --- | --- | --- |
| `keyMaker` | `CacheGroup` | varies per call site (see the `makeCacheKey` overloads) | yes |
| `storageTrie` | `EntityStore.Root` | `[entityIdOrObject, ...storeFieldNames]` | yes |
| `fragmentWatches` | `ApolloCache` | `[fragmentQueryDoc, canonicalStringify({id, optimistic, variables})]` | yes |
| `limitingTrie` | `StoreWriter.flattenFields` (per call) | `[selectionSet, clientOnly, deferred]` | **no** |
| `defaultKeyTrie` | `optimism` module-global | raw arguments | yes |

`CacheGroup.keyMaker` is declared with three typed overloads, which is the cleanest
inventory of what actually gets memoized in the read path:

```ts
// cache/inmemory/entityStore.ts — EntityStore#makeCacheKey
/** overload for `InMemoryCache.maybeBroadcastWatch` */
public makeCacheKey(document: DocumentNode, callback: Cache.WatchCallback<any>, details: string): object;
/** overload for `StoreReader.executeSelectionSet` */
public makeCacheKey(selectionSet: SelectionSetNode, parent: string | StoreObject, varString: string | undefined): object;
/** overload for `StoreReader.executeSubSelectedArray` */
public makeCacheKey(field: FieldNode, array: readonly any[], varString: string | undefined): object;
public makeCacheKey() { return this.group.keyMaker.lookupArray(arguments); }
```

Because `keyMaker` lives on the `CacheGroup`, and `resetCaching()` replaces it with a fresh
`Trie`, discarding a group's memo keys is a single pointer assignment.

### 1.3 `@wry/caches` — the LRU behind every memo

`StrongCache` and `WeakCache` are LRU maps built on a `Map`/`WeakMap` plus a doubly-linked
recency list. `WeakCache` additionally holds keys through `WeakRef` and deregisters
entries via `FinalizationRegistry`, so a memo keyed by a `DocumentNode` cannot pin that
document in memory.

Eviction is *not* eager. `wrap` only calls `cache.clean()` when no computation is in
flight:

```ts
// node_modules/optimism/src/index.ts
if (! parentEntrySlot.hasValue()) {
  caches.forEach(cache => cache.clean());
  caches.clear();
}
```

so a deep recursive read never has entries evicted out from under it mid-traversal.
`dispose` is wired to `entry.dispose()`, so evicting a memo entry dirties its parents —
eviction is a correctness-preserving operation, just a slow one.

Default sizes (`utilities/caching/sizes.ts`) are worth memorising, because they define the
working-set assumptions of the whole cache:

```ts
export const enum defaultCacheSizes {
  // ...
  canonicalStringify = 1000,
  "cache.fragmentQueryDocuments" = 1000,
  "inMemoryCache.maybeBroadcastWatch" = 5000,
  "inMemoryCache.executeSelectionSet" = 50000,
  "inMemoryCache.executeSubSelectedArray" = 10000,
}
```

### 1.4 `@wry/equality` — the change detector

`equal(a, b)` is a cycle-tolerant structural comparison. Three of its behaviours have
direct consequences in the cache:

- **`undefined`-valued keys are ignored.** `definedKeys` filters them out before comparing
  key counts, so `{ a: 1 }` and `{ a: 1, b: undefined }` are equal. This is why a Layer
  tombstone (`field: undefined`) does not spuriously differ from an absent field during
  `Layer.removeLayer` dirtying.
- **Non-native functions with identical source are equal.** Relevant when field policies
  end up inside compared values.
- **Termination on cycles** is guaranteed by a module-level `previousComparisons` map that
  is cleared in a `finally`.

The cache calls `equal` in exactly four places, and each is a *gate*, not a computation:

| Call site | Purpose |
| --- | --- |
| `storeObjectReconciler` | Preserve `===` when a written value matches what is stored. |
| `InMemoryCache.broadcastWatch` | Suppress a watcher callback when the recomputed diff is unchanged. |
| `Layer.removeLayer` | Dirty only the fields whose value will actually change on rollback. |
| `Policies.runMergeFunction` | Reuse a previous `@stream` merge result. |

### 1.5 `DeepMerger` — merging with maximal structure sharing

```ts
// utilities/internal/DeepMerger.ts
public merge(target: any, source: any, mergeOptions: DeepMerger.MergeOptions = {}): any {
  // ... atPath / array-truncation handling elided ...
  if (isNonNullObject(source) && isNonNullObject(target)) {
    Object.keys(source).forEach((sourceKey) => {
      if (hasOwnProperty.call(target, sourceKey)) {
        const targetValue = target[sourceKey];
        if (source[sourceKey] !== targetValue) {
          const result = this.reconciler(target, source, sourceKey);
          // A well-implemented reconciler may return targetValue to indicate
          // the merge changed nothing about the structure of the target.
          if (result !== targetValue) {
            target = this.shallowCopyForMerge(target);
            target[sourceKey] = result;
          }
        }
      } else {
        // If there is no collision, the target can safely share memory with
        // the source, and the recursion can terminate here.
        target = this.shallowCopyForMerge(target);
        target[sourceKey] = source[sourceKey];
      }
    });
    return target;
  }
  return source;
}
```

Three properties the cache depends on:

1. **Copy-on-write.** `target` is only shallow-copied when a key actually changes, so an
   unchanged merge returns the original object by identity.
2. **`pastCopies`** ensures each object is copied at most once per `DeepMerger` instance,
   which is why the writer allocates one merger per write
   (`makeProcessedFieldsMerger()`) and reuses it across the whole traversal.
3. **A pluggable `reconciler`** lets `EntityStore.merge` swap the default recursive merge
   for `storeObjectReconciler`, turning a deep merge into a *shallow field-wise* merge with
   an equality escape hatch.

`mergeDeepArray(sources)` folds a list with one shared merger. `StoreReader` uses it to
assemble a result object from one single-key object per field.

### 1.6 `canonicalStringify` — deterministic keys

```ts
// utilities/internal/canonicalStringify.ts
function stableObjectReplacer(key: string, value: any) {
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const keys = Object.keys(value);
      if (keys.every(everyKeyInOrder)) return value;   // already sorted: no allocation
      const unsortedKey = JSON.stringify(keys);
      let sortedKeys = sortingMap.get(unsortedKey);
      // ...
    }
  }
  return value;
}
```

It is `JSON.stringify` with a replacer that emits object keys in sorted order, memoizing
*key-set permutations* (not values) in an LRU of 1000 entries. It is what makes
`feed({"limit":10,"type":"top"})` independent of the order the caller wrote the variables,
verified by the probe:

```
--- argument canonicalisation ---
{
  "unsortedInput": ["__typename", "search({\"where\":{\"a\":1,\"b\":2}})"],
  "sortedInput":   ["__typename", "search({\"where\":{\"a\":1,\"b\":2}})"]
}
  [PASS] canonicalStringify sorts nested argument keys so both writes collide
```

Non-plain objects (class instances, `Date`) are passed through untouched, so a `Date` in
variables serialises via its own `toJSON`.

### 1.7 `maybeDeepFreeze` — the immutability contract

```ts
export function maybeDeepFreeze<T>(obj: T): T {
  if (__DEV__) { deepFreeze(obj); }
  return obj;
}
```

`InMemoryCache` sets `assumeImmutableResults = true` (overriding the `ApolloCache` default
of `false`). The contract is: **read results and stored values are logically immutable**,
enforced with `Object.freeze` in development and merely assumed in production. Consumers
may therefore compare results with `===` instead of deep equality.

The write path pays for this contract with `cloneDeep`: because a scalar value from a user
result object may later be frozen when it is read back, the writer defensively clones
scalars in development so the caller's own object is never frozen:

```ts
// cache/inmemory/writeToStore.ts — StoreWriter#processFieldValue
if (!field.selectionSet || value === null) {
  // In development, we need to clone scalar values so that they can be
  // safely frozen with maybeDeepFreeze in readFromStore.ts. In production,
  // it's cheaper to store the scalar values directly in the cache.
  return __DEV__ ? cloneDeep(value) : value;
}
```

The probe confirms both halves of the contract (section 15): read results are deeply
frozen, and the caller's input object is not.

---

## Part 2 — The normalized store

`entityStore.ts` contains four classes and one free-standing dependency tracker. This is
where all state lives; `InMemoryCache` itself holds almost nothing.

```mermaid
classDiagram
    class NormalizedCache {
        <<interface>>
        +has(dataId) boolean
        +get(dataId, fieldName) StoreValue
        +merge(olderId, newerObject) void
        +modify(dataId, fields, exact) boolean
        +delete(dataId, fieldName) boolean
        +toObject() NormalizedCacheObject
        +replace(newData) void
        +retain(rootId) number
        +release(rootId) number
        +getFieldValue(objOrRef, name) SafeReadonly
        +toReference(objOrIdOrRef, mergeIntoStore) Reference
        +canRead(value) boolean
        +getStorage(idOrObj, ...names) StorageType
    }
    class EntityStore {
        <<abstract>>
        #data NormalizedCacheObject
        +policies Policies
        +group CacheGroup
        -rootIds Record~string,number~
        -refs Record~string,Record~
        +addLayer(id, replay)* Layer
        +removeLayer(id)* EntityStore
        +getStorage(...)* StorageType
        +lookup(dataId, dependOnExistence) StoreObject
        +evict(options, limit) boolean
        +gc() string[]
        +findChildRefIds(dataId) Record
        +makeCacheKey(...) object
        +extract() NormalizedCacheObject
    }
    class Root {
        +stump Stump
        +storageTrie Trie~StorageType~
        +addLayer(id, replay) Layer
        +removeLayer() Root
    }
    class Layer {
        +id string
        +parent EntityStore
        +replay function
        +removeLayer(id) EntityStore
        +toObject() NormalizedCacheObject
    }
    class Stump {
        +removeLayer() Stump
        +merge(older, newer) void
    }
    class CacheGroup {
        -d OptimisticDependencyFunction
        +keyMaker Trie~object~
        +caching boolean
        -parent CacheGroup
        +depend(dataId, storeFieldName) void
        +dirty(dataId, storeFieldName) void
        +resetCaching() void
    }

    NormalizedCache <|.. EntityStore
    EntityStore <|-- Root
    EntityStore <|-- Layer
    Layer <|-- Stump
    Root "1" *-- "1" Stump : owns
    Layer "1" --> "1" EntityStore : parent
    EntityStore "1" --> "1" CacheGroup : group
    CacheGroup "1" --> "0..1" CacheGroup : parent
```

### 2.1 The layer chain

`InMemoryCache.init()` builds the initial two-node chain:

```ts
// cache/inmemory/inMemoryCache.ts
private init() {
  const rootStore = (this.data = new EntityStore.Root({
    policies: this.policies,
    resultCaching: this.config.resultCaching,
  }));
  // When no optimistic writes are currently active, cache.optimisticData ===
  // cache.data, so there are no additional layers on top of the actual data.
  // ...
  this.optimisticData = rootStore.stump;
  this.resetResultCache();
}
```

Read that comment carefully — it is slightly out of date. `optimisticData` is the
**`Stump`**, not the `Root`. The `Stump` is a permanently-installed empty `Layer` that
exists purely to own a *second* `CacheGroup`:

```ts
// cache/inmemory/entityStore.ts
class Stump extends Layer {
  constructor(root: Root) {
    super("EntityStore.Stump", root, () => {}, new CacheGroup(root.group.caching, root.group));
  }
  public removeLayer() { return this; }              // never removable
  public merge(older, newer) { return this.parent.merge(older, newer); }  // never stores
}
```

```mermaid
flowchart BT
    subgraph optimisticGroup["CacheGroup #2 — optimistic (parent = root group)"]
        direction BT
        L2["<b>Layer</b> id: 'mutation-7'<br/>data: partial overrides<br/>replay: fn"]:::store
        L1["<b>Layer</b> id: 'mutation-6'<br/>data: partial overrides<br/>replay: fn"]:::store
        ST["<b>Stump</b> id: 'EntityStore.Stump'<br/>data: always empty<br/>merge() forwards to Root"]:::store
    end
    subgraph rootGroup["CacheGroup #1 — root (no parent)"]
        RT["<b>Root</b><br/>data: the durable NormalizedCacheObject<br/>storageTrie · stump"]:::store
    end

    L2 -->|parent| L1 -->|parent| ST -->|parent| RT

    RD1["cache.diff({ optimistic: true })<br/>reads from optimisticData"]:::read -.-> L2
    RD2["cache.diff({ optimistic: false })<br/>reads from data"]:::read -.-> RT
    WRT["cache.write(...)<br/>always writes to this.data"]:::write --> RT

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
```

Why the `Stump` exists at all: a `CacheGroup` is the invalidation scope, and optimistic and
non-optimistic reads must be invalidated independently. Without the `Stump`, optimistic
reads with zero active layers would register their dependencies in the root group,
polluting it. With it, `optimisticData` always has its own group even when nothing is
stacked, and layers added later share that same group
(`Layer.addLayer` passes `this.group` through), so the whole optimistic stack is one
invalidation scope no matter how deep it is.

> **Sharp edge.** `Stump.merge` forwards to the `Root`. So `cache.modify({ optimistic: true })`
> with **no active layers** mutates the durable root data, because `optimisticData` *is* the
> `Stump`. Optimistic isolation only exists inside `cache.batch({ optimistic: "someId" })`.

### 2.2 Reading a field through the chain

```ts
// cache/inmemory/entityStore.ts
public get(dataId: string, fieldName: string): StoreValue {
  this.group.depend(dataId, fieldName);
  if (hasOwn.call(this.data, dataId)) {
    const storeObject = this.data[dataId];
    if (storeObject && hasOwn.call(storeObject, fieldName)) {
      return storeObject[fieldName];
    }
  }
  if (fieldName === "__typename" && hasOwn.call(this.policies.rootTypenamesById, dataId)) {
    return this.policies.rootTypenamesById[dataId];
  }
  if (this instanceof Layer) {
    return this.parent.get(dataId, fieldName);
  }
}
```

Four behaviours packed into fifteen lines:

1. **`group.depend` runs first, unconditionally** — including for fields that turn out to
   be missing. Absence is a tracked dependency, so writing a previously-absent field
   correctly invalidates readers that observed it missing.
2. **Own-property checks, not truthiness.** A key present with value `undefined` **stops
   the lookup** and returns `undefined` without consulting the parent. That is the
   *tombstone* representation: a `Layer` deletes a field by storing `undefined` for it.
3. **Root `__typename` synthesis.** `ROOT_QUERY.__typename` resolves to `"Query"` even if
   nothing ever wrote it.
4. **Parent recursion** happens only for `Layer`s, so a chain of depth *d* costs at most
   *d* hash lookups.

`lookup(dataId, dependOnExistence?)` is the whole-object analogue. Its optional
`__exists` dependency is what `has()` uses:

```ts
protected lookup(dataId: string, dependOnExistence?: boolean): StoreObject | undefined {
  // The has method (above) calls lookup with dependOnExistence = true, so
  // that it can later be invalidated when we add or remove a StoreObject for
  // this dataId. Any consumer who cares about the contents of the StoreObject
  // should not rely on this dependency, since the contents could change
  // without the object being added or removed.
  if (dependOnExistence) this.group.depend(dataId, "__exists");
  if (hasOwn.call(this.data, dataId)) return this.data[dataId];
  if (this instanceof Layer) return this.parent.lookup(dataId, dependOnExistence);
  if (this.policies.rootTypenamesById[dataId]) return {};
}
```

The last line means `ROOT_QUERY`/`ROOT_MUTATION`/`ROOT_SUBSCRIPTION` always "exist" as
empty objects, which is why reading a never-written query yields "missing field" errors
rather than "dangling reference".

Three bound helpers are handed to user-supplied field policy functions and to
`StoreReader`:

```ts
public getFieldValue = <T = StoreValue>(objectOrReference, storeFieldName) =>
  maybeDeepFreeze(
    isReference(objectOrReference)
      ? this.get(objectOrReference.__ref, storeFieldName)
      : objectOrReference && objectOrReference[storeFieldName]
  ) as SafeReadonly<T>;

public canRead: CanReadFunction = (objOrRef) =>
  isReference(objOrRef) ? this.has(objOrRef.__ref) : typeof objOrRef === "object";

public toReference: ToReferenceFunction = (objOrIdOrRef, mergeIntoStore) => {
  if (typeof objOrIdOrRef === "string") return makeReference(objOrIdOrRef);
  if (isReference(objOrIdOrRef)) return objOrIdOrRef;
  const [id] = this.policies.identify(objOrIdOrRef);
  if (id) {
    const ref = makeReference(id);
    if (mergeIntoStore) this.merge(id, objOrIdOrRef);
    return ref;
  }
};
```

`canRead` is the dangling-reference filter: it is how `relayStylePagination`'s `read`
function drops edges whose nodes have been evicted, and how
`StoreReader.execSubSelectedArrayImpl` prunes arrays.

### 2.3 `NormalizedCacheObject` and `__META`

```ts
// cache/inmemory/types.ts
export interface NormalizedCacheObject {
  __META?: {
    // Well-known singleton IDs like ROOT_QUERY and ROOT_MUTATION are
    // always considered to be root IDs during cache.gc garbage
    // collection, but other IDs can become roots if they are written
    // directly with cache.writeFragment or retained explicitly with
    // cache.retain. When such IDs exist, we include them in the __META
    // section so that they can survive cache.{extract,restore}.
    extraRootIds: string[];
  };
  [dataId: string]: StoreObject | undefined;
}
```

`extract()` computes `__META` from the retainment table, and `replace()` re-retains them:

```ts
public extract(): NormalizedCacheObject {
  const obj = this.toObject();
  const extraRootIds: string[] = [];
  this.getRootIdSet().forEach((id) => {
    if (!hasOwn.call(this.policies.rootTypenamesById, id)) extraRootIds.push(id);
  });
  if (extraRootIds.length) obj.__META = { extraRootIds: extraRootIds.sort() };
  return obj;
}

public replace(newData: NormalizedCacheObject | null): void {
  Object.keys(this.data).forEach((dataId) => {
    if (!(newData && hasOwn.call(newData, dataId))) this.delete(dataId);
  });
  if (newData) {
    const { __META, ...rest } = newData;
    Object.keys(rest).forEach((dataId) => this.merge(dataId, rest[dataId] as StoreObject));
    if (__META) __META.extraRootIds.forEach(this.retain, this);
  }
}
```

Note that `replace` **merges** rather than assigns, so a restore over a non-empty store
unions the two. `InMemoryCache.restore` avoids that by calling `init()` first.

### 2.4 `CacheGroup` — the dependency graph

```ts
// cache/inmemory/entityStore.ts
class CacheGroup {
  private d: OptimisticDependencyFunction<string> | null = null;
  public keyMaker!: Trie<object>;

  constructor(public readonly caching: boolean, private parent: CacheGroup | null = null) {
    this.resetCaching();
  }

  public resetCaching() {
    this.d = this.caching ? dep<string>() : null;
    this.keyMaker = new Trie();
  }

  public depend(dataId: string, storeFieldName: string) {
    if (this.d) {
      this.d(makeDepKey(dataId, storeFieldName));
      const fieldName = fieldNameFromStoreName(storeFieldName);
      if (fieldName !== storeFieldName) {
        // Fields with arguments that contribute extra identifying
        // information to the fieldName (thus forming the storeFieldName)
        // depend not only on the full storeFieldName but also on the
        // short fieldName, so the field can be invalidated using either
        // level of specificity.
        this.d(makeDepKey(dataId, fieldName));
      }
      if (this.parent) { this.parent.depend(dataId, storeFieldName); }
    }
  }

  public dirty(dataId: string, storeFieldName: string) {
    if (this.d) {
      this.d.dirty(
        makeDepKey(dataId, storeFieldName),
        storeFieldName === "__exists" ? "forget" : "setDirty"
      );
    }
  }
}

function makeDepKey(dataId: string, storeFieldName: string) {
  // Since field names cannot have '#' characters in them, this method
  // of joining the field name and the ID should be unambiguous, and much
  // cheaper than JSON.stringify([dataId, fieldName]).
  return storeFieldName + "#" + dataId;
}
```

Four design decisions here deserve their own paragraph each.

**Two-level dependency keys.** Reading `feed({"type":"top"})` on `ROOT_QUERY` registers
*both* `feed({"type":"top"})#ROOT_QUERY` and `feed#ROOT_QUERY`. That lets
`cache.evict({ id: "ROOT_QUERY", fieldName: "feed" })` invalidate every argument variant
with a single dirty call, and it is why the probe shows a bare-`fieldName` eviction
removing all `feed(...)` keys.

**Parent chaining on `depend` only.** The optimistic group's parent is the root group, so
an optimistic read registers in *both* groups. But `dirty` never chains. The asymmetry
produces exactly the desired semantics:

```mermaid
flowchart LR
    subgraph reads["Dependency registration — depend() chains upward"]
        ORD["optimistic read<br/>store = Layer/Stump"]:::read -->|depend| OG["optimistic group"]:::memo
        OG -->|"parent.depend"| RG["root group"]:::memo
        RRD["non-optimistic read<br/>store = Root"]:::read -->|depend| RG
    end
    subgraph writes["Invalidation — dirty() does NOT chain"]
        LW["Layer.merge<br/>(optimistic write)"]:::write -->|dirty| OG2["optimistic group"]:::memo
        RW["Root.merge<br/>(server write)"]:::write -->|dirty| RG2["root group"]:::memo
    end
    OG2 -.->|"invalidates only<br/>optimistic readers"| X1["optimistic memo entries"]:::dirty
    RG2 -.->|"invalidates BOTH<br/>(optimistic readers<br/>registered here too)"| X2["optimistic + root<br/>memo entries"]:::dirty

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

A server write invalidates optimistic readers (they can see through to the root), while an
optimistic write leaves non-optimistic readers alone (they cannot see the layer). Exactly
right, and achieved with one `if (this.parent)`.

**`__exists` uses `forget`, not `setDirty`.** When an entity appears or disappears,
everything the memo layer believes about it is suspect, so the dependency set is removed
from the graph entirely rather than merely marked stale. The rationale is recorded in a
free function used by `StoreReader`:

```ts
export function maybeDependOnExistenceOfEntity(store: NormalizedCache, entityId: string) {
  if (supportsResultCaching(store)) {
    // We use this pseudo-field __exists elsewhere in the EntityStore code to
    // represent changes in the existence of the entity object identified by
    // entityId. This dependency gets reliably dirtied whenever an object with
    // this ID is deleted (or newly created) within this group, so any result
    // cache entries (for example, StoreReader#executeSelectionSet results) that
    // depend on __exists for this entityId will get dirtied as well, leading to
    // the eventual recomputation (instead of reuse) of those result objects the
    // next time someone reads them from the cache.
    store.group.depend(entityId, "__exists");
  }
}
```

**`caching: false` is a null object.** With `resultCaching: false`, `this.d` stays `null`,
so `depend`/`dirty` are no-ops, and `supportsResultCaching(store)` returns false, which in
turn makes every `makeCacheKey` return `undefined`, which in turn makes `optimism` bypass
memoization. One config flag disables three layers with no branching in the hot code.

### 2.5 State transitions of a single `(dataId, storeFieldName)`

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Absent : entity never written

    Absent --> Present : store.merge writes a value<br/>dirty(id, field) + dirty(id, __exists)
    Present --> Present : merge with a different value<br/>dirty(id, field)
    Present --> PresentSame : merge with a deeply-equal value<br/>storeObjectReconciler keeps existing<br/>NO dirty
    PresentSame --> Present : subsequent differing merge

    Present --> Invalidated : modify returns INVALIDATE<br/>dirty(id, field), value unchanged
    Invalidated --> Present : next read recomputes

    Present --> Absent : modify returns DELETE (Root)<br/>field removed from StoreObject
    Present --> Tombstoned : modify returns DELETE (Layer)<br/>field set to undefined
    Tombstoned --> Present : layer removed<br/>Layer.removeLayer dirties reexposed fields

    Present --> EntityGone : evict / gc / delete(dataId)<br/>dirty(id, __exists) with "forget"
    EntityGone --> Dangling : other entities still hold { __ref }
    Dangling --> Present : entity rewritten

    EntityGone --> [*]

    note right of PresentSame
        The no-dirty transition is the
        single most important perf
        property of the write path.
    end note
    note right of Dangling
        StoreReader returns
        "Dangling reference to missing X object"
        and canRead(ref) === false.
    end note
```

### 2.6 Writes: `merge` and `storeObjectReconciler`

```ts
// cache/inmemory/entityStore.ts
public merge(older: string | StoreObject, newer: StoreObject | string): void {
  let dataId: string | undefined;
  if (isReference(older)) older = older.__ref;
  if (isReference(newer)) newer = newer.__ref;

  const existing: StoreObject | undefined =
    typeof older === "string" ? this.lookup((dataId = older)) : older;
  const incoming: StoreObject | undefined =
    typeof newer === "string" ? this.lookup((dataId = newer)) : newer;

  if (!incoming) return;
  invariant(typeof dataId === "string", "store.merge expects a string ID");

  const merged: StoreObject = new DeepMerger({ reconciler: storeObjectReconciler })
    .merge(existing, incoming);

  // Even if merged === existing, existing may have come from a lower
  // layer, so we always need to set this.data[dataId] on this level.
  this.data[dataId] = merged;
  // ... dirtying, below
}
```

The reconciler is what makes the merge shallow-but-identity-preserving:

```ts
function storeObjectReconciler(existingObject, incomingObject, property): StoreValue {
  const existingValue = existingObject[property];
  const incomingValue = incomingObject[property];
  // Wherever there is a key collision, prefer the incoming value, unless
  // it is deeply equal to the existing value. It's worth checking deep
  // equality here (even though blindly returning incoming would be
  // logically correct) because preserving the referential identity of
  // existing data can prevent needless rereading and rerendering.
  return equal(existingValue, incomingValue) ? existingValue : incomingValue;
}
```

Because the reconciler never recurses, `EntityStore.merge` is a **field-wise** merge, not a
deep one. Nested non-normalized objects are replaced wholesale unless a merge function
intervened earlier in the write pipeline — which is precisely the "Cache data may be lost"
scenario ([§4.8](#48-warnaboutdataloss)). The probe pins this:

```
--- non-normalized child merge behaviour ---
{
  "withoutMergePolicy": { "__typename": "Prefs", "locale": "en" },
  "withMergeTrue":      { "__typename": "Prefs", "theme": "dark", "locale": "en" }
}
```

The dirtying half runs only when the merge actually changed something:

```ts
if (merged !== existing) {
  delete this.refs[dataId];                      // invalidate the findChildRefIds memo
  if (this.group.caching) {
    const fieldsToDirty: Record<string, 1> = {};
    if (!existing) fieldsToDirty.__exists = 1;   // entity newly created

    Object.keys(incoming).forEach((storeFieldName) => {
      if (!existing || existing[storeFieldName] !== merged[storeFieldName]) {
        fieldsToDirty[storeFieldName] = 1;

        // Also dirty fieldNameFromStoreName(storeFieldName) if it's
        // different from storeFieldName and this field does not have
        // keyArgs configured, ...
        const fieldName = fieldNameFromStoreName(storeFieldName);
        if (fieldName !== storeFieldName && !this.policies.hasKeyArgs(merged.__typename, fieldName)) {
          fieldsToDirty[fieldName] = 1;
        }

        // If merged[storeFieldName] has become undefined, and this is the
        // Root layer, actually delete the property from the merged object, ...
        if (merged[storeFieldName] === void 0 && !(this instanceof Layer)) {
          delete merged[storeFieldName];
        }
      }
    });

    if (fieldsToDirty.__typename && !(existing && existing.__typename) &&
        this.policies.rootTypenamesById[dataId] === merged.__typename) {
      delete fieldsToDirty.__typename;           // don't dirty synthesised root __typename
    }
    Object.keys(fieldsToDirty).forEach((fieldName) =>
      this.group.dirty(dataId as string, fieldName));
  }
}
```

Two asymmetries to internalise:

- **Only keys present in `incoming` are examined.** A merge cannot dirty a field it did not
  mention, which keeps invalidation proportional to the payload, not the entity.
- **`hasKeyArgs` gates short-name dirtying.** If a field has an explicit `keyArgs`
  configuration, the cache trusts that different argument variants are genuinely
  independent, so writing `feed:{"type":"top"}` does *not* dirty `feed`. Without `keyArgs`,
  it must assume variants are interrelated and dirty the short name too. This directly
  changes how much re-reading a paginated write triggers.

### 2.7 `modify` — user-controlled field surgery

```mermaid
flowchart TB
    START["store.modify(dataId, fields, exact)"]:::api --> LK["storeObject = this.lookup(dataId)"]:::store
    LK -->|"undefined"| RF["return false"]:::dirty
    LK -->|"found"| LOOP["for each storeFieldName in storeObject"]:::write

    LOOP --> PICK{"pick modifier<br/>fn? fields :<br/>fields[storeFieldName]<br/>?? (exact ? none : fields[fieldName])"}:::write
    PICK -->|"none"| NEXT["keep field<br/>allDeleted = false"]:::store
    PICK -->|"found"| CALL["newValue = modify(<br/>  maybeDeepFreeze(fieldValue),<br/>  { DELETE, INVALIDATE, readField,<br/>    canRead, toReference, isReference,<br/>    fieldName, storeFieldName, storage })"]:::write

    CALL --> SW{"newValue"}:::write
    SW -->|"=== INVALIDATE"| INV["group.dirty(dataId, storeFieldName)<br/>value unchanged"]:::dirty
    SW -->|"=== DELETE"| DEL["newValue = undefined<br/>changedFields[k] = undefined<br/>needToMerge = true"]:::dirty
    SW -->|"=== fieldValue"| NOOP["no change"]:::store
    SW -->|"other"| CHG["changedFields[k] = newValue<br/>needToMerge = true<br/>__DEV__: warn on unstored Reference<br/>or mixed Ref/Object arrays"]:::write

    INV --> NEXT2["next field"]:::write
    DEL --> NEXT2
    NOOP --> NEXT2
    CHG --> NEXT2
    NEXT --> NEXT2
    NEXT2 --> LOOP

    LOOP -->|"done"| MERGE{"needToMerge?"}:::write
    MERGE -->|"no"| RF2["return false"]:::dirty
    MERGE -->|"yes"| DOMERGE["this.merge(dataId, changedFields)"]:::write
    DOMERGE --> ALLDEL{"allDeleted?"}:::write
    ALLDEL -->|"yes, Layer"| TOMB["this.data[dataId] = undefined<br/>group.dirty(dataId, '__exists')"]:::dirty
    ALLDEL -->|"yes, Root"| DELE["delete this.data[dataId]<br/>group.dirty(dataId, '__exists')"]:::dirty
    ALLDEL -->|"no"| RT["return true"]:::api
    TOMB --> RT
    DELE --> RT

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Key facts, all pinned by probe section 8:

- **`modify` iterates the *existing* `StoreObject`'s keys.** It cannot create a field that
  is not already there, and it does nothing at all for an unknown `dataId` (returns
  `false`, creates nothing).
- **Modifier lookup is two-level.** For `storeFieldName = 'feed({"type":"top"})'`, it tries
  `fields['feed({"type":"top"})']` first, then falls back to `fields.feed` unless `exact`.
  `exact` is `true` only when `delete()` was called with explicit `args`.
- **`DELETE` and `INVALIDATE` are branded empty objects** compared by identity
  (`const DELETE = {} as DeleteModifier`), so they cannot collide with user data.
- **`INVALIDATE` returns `false`** from `modify` overall (it sets no `changedFields`), even
  though it did dirty a dependency. The probe pins this asymmetry.
- **The `allDeleted` branch** is how deleting every field removes the entity, with the
  Root/Layer split described in §2.5.

`delete` is a thin wrapper that resolves an argument-specific `storeFieldName` first:

```ts
public delete(dataId: string, fieldName?: string, args?: Record<string, any>) {
  const storeObject = this.lookup(dataId);
  if (storeObject) {
    const typename = this.getFieldValue<string>(storeObject, "__typename");
    const storeFieldName =
      fieldName && args ? this.policies.getStoreFieldName({ typename, fieldName, args }) : fieldName;
    return this.modify(dataId, storeFieldName ? { [storeFieldName]: delModifier } : delModifier, !!args);
  }
  return false;
}
```

### 2.8 `evict` — deletion across the layer chain

```ts
public evict(options: Cache.EvictOptions, limit: EntityStore): boolean {
  let evicted = false;
  if (options.id) {
    if (hasOwn.call(this.data, options.id)) {
      evicted = this.delete(options.id, options.fieldName, options.args);
    }
    if (this instanceof Layer && this !== limit) {
      evicted = this.parent.evict(options, limit) || evicted;
    }
    // Always invalidate the field to trigger rereading of watched
    // queries, even if no cache data was modified by the eviction,
    // because queries may depend on computed fields with custom read
    // functions, whose values are not stored in the EntityStore.
    if (options.fieldName || evicted) {
      this.group.dirty(options.id, options.fieldName || "__exists");
    }
  }
  return evicted;
}
```

Eviction descends the chain, stopping at `limit`. `InMemoryCache.evict` supplies that
limit:

```ts
// Pass this.data as a limit on the depth of the eviction, so evictions
// during optimistic updates (when this.data is temporarily set equal to
// this.optimisticData) do not escape their optimistic Layer.
return this.optimisticData.evict(options, this.data);
```

Outside a transaction, `this.data` is the `Root`, so eviction reaches everything. Inside
`batch({ optimistic: "id" })`, `this.data` has been temporarily reassigned to the new
`Layer`, so `this !== limit` fails immediately and the eviction is confined to that layer —
an optimistic delete that rolls back cleanly.

The unconditional `group.dirty` when `fieldName` is supplied is the escape hatch for
`read` functions: a computed field has no stored value to compare, so eviction must dirty
it blindly.

### 2.9 Garbage collection

The cache is a **mark-and-sweep collector over the reference graph**, rooted at the
well-known root ids plus anything explicitly retained.

```mermaid
flowchart TB
    subgraph roots["1. Compute the root set — getRootIdSet()"]
        R1["this.rootIds<br/>(retain/release counters<br/>for this store)"]:::store
        R2["parent.getRootIdSet()<br/>(walk up every Layer)"]:::store
        R3["policies.rootTypenamesById keys<br/>ROOT_QUERY / ROOT_MUTATION /<br/>ROOT_SUBSCRIPTION<br/>— always roots"]:::store
        R1 --> RS["ids: Set&lt;string&gt;"]:::store
        R2 --> RS
        R3 --> RS
    end

    RS --> SNAP["2. snapshot = this.toObject()<br/>(flattened view of the whole chain)"]:::store

    SNAP --> MARK["3. Mark: ids.forEach(id =&gt; ...)<br/>if snapshot has id:<br/>  add findChildRefIds(id) to ids<br/>  delete snapshot[id]"]:::read
    MARK -->|"Set.forEach visits<br/>newly added ids too —<br/>this IS the BFS"| MARK

    MARK --> SWEEP["4. idsToRemove = Object.keys(snapshot)<br/>(everything never marked)"]:::dirty
    SWEEP --> DEL["5. walk to the Root, then<br/>idsToRemove.forEach(id =&gt; root.delete(id))<br/>each delete() dirties __exists"]:::dirty
    DEL --> RET["return idsToRemove"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

```ts
public gc() {
  const ids = this.getRootIdSet();
  const snapshot = this.toObject();
  ids.forEach((id) => {
    if (hasOwn.call(snapshot, id)) {
      // Because we are iterating over an ECMAScript Set, the IDs we add here
      // will be visited in later iterations of the forEach loop only if they
      // were not previously contained by the Set.
      Object.keys(this.findChildRefIds(id)).forEach(ids.add, ids);
      // By removing IDs from the snapshot object here, we protect them from
      // getting removed from the root store layer below.
      delete snapshot[id];
    }
  });
  const idsToRemove = Object.keys(snapshot);
  if (idsToRemove.length) {
    let root: EntityStore = this;
    while (root instanceof Layer) root = root.parent;
    idsToRemove.forEach((id) => root.delete(id));
  }
  return idsToRemove;
}
```

The traversal exploits a specification guarantee: `Set.prototype.forEach` visits elements
added during iteration. The whole breadth-first mark phase is therefore one `forEach` with
no explicit queue.

`findChildRefIds` scans one entity for `{ __ref }` values, memoized per `dataId` and
invalidated by `delete this.refs[dataId]` inside `merge`:

```ts
public findChildRefIds(dataId: string): Record<string, true> {
  if (!hasOwn.call(this.refs, dataId)) {
    const found = (this.refs[dataId] = {} as Record<string, true>);
    const root = this.data[dataId];
    if (!root) return found;
    const workSet = new Set<Record<string | number, any>>([root]);
    // Within the store, only arrays and objects can contain child entity
    // references, so we can prune the traversal using this predicate:
    workSet.forEach((obj) => {
      if (isReference(obj)) {
        found[obj.__ref] = true;
        // In rare cases, a { __ref } Reference object may have other fields.
        // ... fall through to handle any other properties of obj.
      }
      if (isNonNullObject(obj)) {
        Object.keys(obj).forEach((key) => {
          const child = obj[key];
          if (isNonNullObject(child)) workSet.add(child);
        });
      }
    });
  }
  return this.refs[dataId];
}
```

Retention is a **counter**, not a flag:

```ts
public retain(rootId: string): number { return (this.rootIds[rootId] = (this.rootIds[rootId] || 0) + 1); }
public release(rootId: string): number {
  if (this.rootIds[rootId] > 0) {
    const count = --this.rootIds[rootId];
    if (!count) delete this.rootIds[rootId];
    return count;
  }
  return 0;
}
```

and the writer retains automatically:

```ts
// cache/inmemory/writeToStore.ts — end of writeToStore
// Any IDs written explicitly to the cache will be retained as
// reachable root IDs for garbage collection purposes. ...
store.retain(ref.__ref);
```

so `cache.writeFragment({ id: "Book:3", ... })` pins `Book:3` forever until released.
Probe section 9 pins the full lifecycle: unreachable entities collected, auto-retained
entities surviving, `__META` round-tripping through `extract`/`restore`, and the counter
semantics of `retain`/`release`.

> **`gc()` is never called automatically.** `InMemoryCache.gc()` exists but nothing in
> `src/core/**` invokes it. Unreferenced entities accumulate until application code (or
> Apollo DevTools) calls it.

### 2.10 Layer removal and replay

Removing an optimistic layer is the most intricate operation in `entityStore.ts`, because
the layers above the removed one must be **replayed** on top of the new parent.

```mermaid
sequenceDiagram
    autonumber
    participant C as InMemoryCache
    participant L2 as Layer "B" (top)
    participant L1 as Layer "A" (target)
    participant ST as Stump
    participant RT as Root

    rect rgb(219, 234, 254)
    Note over C: cache.removeOptimistic("A")
    C->>L2: removeLayer("A")
    end

    rect rgb(226, 232, 240)
    Note over L2,ST: 1. Recurse to the bottom first
    L2->>L1: parent.removeLayer("A")
    L1->>ST: parent.removeLayer("A")
    ST-->>L1: returns itself (Stump is never removable)
    end

    rect rgb(254, 202, 202)
    Note over L1: 2. id matches — dirty everything this layer shadowed
    loop for each dataId in L1.data
        alt parent has no such entity
            L1->>L1: this.delete(dataId) — dirty removed fields
        else layer stored a tombstone (undefined)
            L1->>L1: dirty(dataId, "__exists") + dirty every parent field
        else objects differ
            L1->>L1: dirty only fields where !equal(own, parent)
        end
    end
    L1-->>L2: returns Stump (the new parent)
    end

    rect rgb(253, 230, 138)
    Note over L2: 3. Parent changed — recreate this layer on it
    L2->>ST: parent.addLayer("B", this.replay)
    ST->>ST: new Layer("B", Stump, replay, group)
    Note right of ST: constructor calls replay(this),<br/>re-running the original update fn<br/>against the new parent
    end

    ST-->>C: new top layer
    C->>C: this.optimisticData = newTop<br/>broadcastWatches()
```

```ts
// cache/inmemory/entityStore.ts — Layer#removeLayer
public removeLayer(layerId: string): EntityStore {
  // Remove all instances of the given id, not just the first one.
  const parent = this.parent.removeLayer(layerId);
  if (layerId === this.id) {
    if (this.group.caching) {
      // Dirty every ID we're removing. Technically we might be able to avoid
      // dirtying fields that have values in higher layers, but we don't have
      // easy access to higher layers here, and we're about to recreate those
      // layers anyway (see parent.addLayer below).
      Object.keys(this.data).forEach((dataId) => { /* three cases, above */ });
    }
    return parent;
  }
  // No changes are necessary if the parent chain remains identical.
  if (parent === this.parent) return this;
  // Recreate this layer on top of the new parent.
  return parent.addLayer(this.id, this.replay);
}
```

This is why `Layer` stores its `replay` function permanently, and why an optimistic
`update` function **must be pure and idempotent** — it can be re-executed any number of
times, against a different parent state each time. Probe section 6 demonstrates the
replay: with layer A writing `"optimistic-A"` and layer B appending `"+B"`, removing A
yields `"server+B"`, not `"optimistic-A"` or `"server"`.

---

## Part 3 — `Policies`

`EntityStore` knows how to store things but not *what to call them*. Every naming
decision — which objects become entities, what their ids are, what key a field is stored
under, whether a fragment applies — lives in `policies.ts`. It is the largest file in the
cache (1216 lines) and the only one that user configuration flows into.

```mermaid
flowchart TB
    subgraph cfg["Configuration in"]
        TP["typePolicies<br/>keyFields · merge ·<br/>queryType/mutationType/subscriptionType ·<br/>fields{keyArgs, read, merge}"]:::ext
        PT["possibleTypes<br/>supertype → subtypes[]"]:::ext
        DIF["dataIdFromObject<br/>(legacy global fallback)"]:::ext
    end

    subgraph state["Internal state"]
        TPS["typePolicies<br/>{ keyFn, merge, fields{} }<br/><i>lazily materialised</i>"]:::store
        TBA["toBeAdded<br/>pending TypePolicy[] inbox"]:::store
        SM["supertypeMap<br/>Map&lt;subtype, Set&lt;supertype&gt;&gt;<br/><i>inverted for upward search</i>"]:::store
        FZ["fuzzySubtypes<br/>Map&lt;string, RegExp&gt;"]:::store
        RT["rootIdsByTypename<br/>rootTypenamesById"]:::store
    end

    subgraph api["Public surface"]
        ID["identify(object, ctx)<br/>→ [dataId?, keyObject?]"]:::write
        SFN["getStoreFieldName(fieldSpec)<br/>→ storeFieldName"]:::write
        RF["readField(options, ctx)<br/>→ value (runs read fns)"]:::read
        GM["getMergeFunction(parent, field, child)<br/>runMergeFunction(...)"]:::write
        FM["fragmentMatches(fragment, typename,<br/>result?, variables?)"]:::read
        HKA["hasKeyArgs(typename, fieldName)"]:::read
    end

    TP --> TBA --> TPS
    PT --> SM
    PT --> FZ
    TP --> RT
    DIF --> ID

    TPS --> ID & SFN & RF & GM & HKA
    SM --> FM
    FZ --> FM
    RT --> ID

    KEX["key-extractor.ts<br/>keyFieldsFnFromSpecifier<br/>keyArgsFnFromSpecifier<br/>collectSpecifierPaths"]:::memo
    KEX --> ID
    KEX --> SFN

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

### 3.1 Lazy materialisation and supertype inheritance

`addTypePolicies` does **not** install policies. It pushes them into a per-typename inbox:

```ts
// cache/inmemory/policies.ts
public addTypePolicies(typePolicies: TypePolicies) {
  Object.keys(typePolicies).forEach((typename) => {
    const { queryType, mutationType, subscriptionType, ...incoming } = typePolicies[typename];
    // Though {query,mutation,subscription}Type configurations are rare,
    // it's important to call setRootTypename as early as possible, ...
    if (queryType) this.setRootTypename("Query", typename);
    if (mutationType) this.setRootTypename("Mutation", typename);
    if (subscriptionType) this.setRootTypename("Subscription", typename);

    if (hasOwn.call(this.toBeAdded, typename)) {
      this.toBeAdded[typename].push(incoming);
    } else {
      this.toBeAdded[typename] = [incoming];
    }
  });
}
```

The inbox is drained by `getTypePolicy(typename)`, which runs its inheritance step **at most
once per typename** and then drains any pending updates:

```mermaid
flowchart TB
    CALL["getTypePolicy(typename)"]:::api --> HAS{"hasOwn(this.typePolicies, typename)?"}:::read
    HAS -->|"yes — already materialised"| DRAIN
    HAS -->|"no — first access"| CREATE["typePolicies[typename] = { fields: {} }"]:::store
    CREATE --> SUP["supertypes = supertypeMap.get(typename)"]:::read
    SUP -->|"none, and fuzzySubtypes.size"| FUZZ["create empty supertype set,<br/>add supertypes of every fuzzy<br/>RegExp that matches typename"]:::read
    SUP -->|"found"| INH
    FUZZ --> INH["for each supertype (insertion order):<br/>Object.assign(policy, {...rest})<br/>Object.assign(policy.fields, fields)<br/><i>recursive: getTypePolicy(supertype)</i>"]:::write
    INH --> DRAIN["inbox = toBeAdded[typename]<br/>inbox.splice(0).forEach(updateTypePolicy)"]:::write
    DRAIN --> RET["return typePolicies[typename]"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
```

Three consequences that the source comments call out explicitly:

- **Order-independence, but only until first use.** You may add policies for a subtype
  before its supertype, as long as both are registered before the first `getTypePolicy`
  call for the subtype. After that, `// future changes to inherited supertype policies
  will not be reflected in this subtype policy, because this code runs at most once per
  typename.`
- **Field-policy inheritance is atomic.** `updateTypePolicy` refuses to merge an inherited
  field policy with a new one, because `read` and `merge` cooperate:

  ```ts
  // Field policy inheritance is atomic/shallow: you can't inherit a
  // field policy and then override just its read function, since read
  // and merge functions often need to cooperate, ...
  if (!existing || existing?.typename !== typename) {
    existing = existingFieldPolicies[fieldName] = { typename };
  }
  ```

  The `typename` stamp on `InternalFieldPolicy` exists solely to detect "this entry was
  inherited from a supertype, so replace it wholesale."
- **Root typenames are immutable after the first assignment.**
  `setRootTypename` throws `Cannot change root Query __typename more than once` if you try
  to move `ROOT_QUERY` twice.

### 3.2 Entity identity: `Policies.identify`

```mermaid
flowchart TB
    START["identify(object, partialContext?)"]:::api
    START --> TN["typename =<br/>partialContext.typename ??<br/>partialContext.storeObject.__typename ??<br/>object.__typename"]:::read
    TN --> RQ{"typename === rootTypenamesById.ROOT_QUERY?"}:::read
    RQ -->|"yes"| RETQ["return ['ROOT_QUERY']<br/><i>no keyObject</i>"]:::api
    RQ -->|"no"| CTX["storeObject = partialContext.storeObject ?? object<br/>context.readField defaults to a reader<br/>bound to cache['data'] (the Root store)"]:::store
    CTX --> PICK["keyFn = getTypePolicy(typename).keyFn<br/>|| config.dataIdFromObject"]:::read
    PICK --> LOOP{"keyFn?"}:::write
    LOOP -->|"undefined"| NOID["id = undefined"]:::dirty
    LOOP -->|"defined"| RUN["specifierOrId = keyFn({...object, ...storeObject}, context)<br/><i>inside disableWarningsSlot.withValue(true)</i>"]:::write
    RUN --> ARR{"isArray(specifierOrId)?"}:::write
    ARR -->|"yes — a KeySpecifier"| COMPILE["keyFn = keyFieldsFnFromSpecifier(specifierOrId)<br/>loop again"]:::memo
    COMPILE --> LOOP
    ARR -->|"no"| SET["id = specifierOrId; break"]:::write
    SET --> COERCE["id = id ? String(id) : undefined"]:::dirty
    NOID --> COERCE
    COERCE --> OUT["return context.keyObject ? [id, keyObject] : [id]"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Details that are easy to miss and that change behaviour:

- **The `while (keyFn)` loop supports one indirection.** A `keyFields` *function* may
  return a `KeySpecifier` array, which is then compiled and re-invoked. This is how a
  dynamic policy can defer to the declarative machinery.
- **`{ ...object, ...storeObject }`** is the argument, not `object`. During a write,
  `storeObject` is the partially-built normalized object (aliases resolved, children
  already turned into `Reference`s), and `object` is the raw result. Spreading gives the
  key function de-aliased values with raw values as a fallback.
- **`id ? String(id) : void 0` swallows falsy ids.** An entity whose computed id is `0` or
  `""` is treated as unidentifiable. This is why `defaultDataIdFromObject` uses `id != null`
  checks internally and produces the string `"Todo:0"` rather than returning `0`.
- **Only `ROOT_QUERY` gets the shortcut.** The comment explains why:
  `// It should be possible to write root Query fields with writeFragment, using
  { __typename: "Query", ... } as the data, but it does not make sense to allow the same
  identification behavior for the Mutation and Subscription types`.
- **`context.keyObject` is an out-parameter.** Key functions write to it so
  `StoreWriter` can merge the identifying fields into the store even when the query never
  selected them ([§4.5](#45-identification-and-the-keyobject-back-channel)).
- **`disableWarningsSlot`** silences data-masking warnings while key fields are read, so
  identifying a masked object does not spam the console.

#### `defaultDataIdFromObject`

```ts
// cache/inmemory/helpers.ts
export function defaultDataIdFromObject(
  { __typename, id, _id }: Readonly<StoreObject>,
  context?: KeyFieldsContext
): string | undefined {
  if (typeof __typename === "string") {
    if (context) {
      context.keyObject =
        id != null ? { id }
        : _id != null ? { _id }
        : void 0;
    }
    // If there is no object.id, fall back to object._id.
    if (id == null && _id != null) { id = _id; }
    if (id != null) {
      return `${__typename}:${
        typeof id === "number" || typeof id === "string" ? id : JSON.stringify(id)
      }`;
    }
  }
}
```

Returning `undefined` — no `__typename`, or no `id`/`_id` — is the signal for
**"do not normalize"**. The object stays inline in its parent, exactly as
`EditTodoResponse` did in [§0.2](#02-the-blogs-example-as-the-cache-actually-stores-it).

#### `keyFields` specifiers

`keyFieldsFnFromSpecifier` compiles a `KeySpecifier` — a nested array of strings — into a
key function. The output format is `${typename}:${JSON.stringify(keyObject)}`:

```ts
// cache/inmemory/key-extractor.ts
return (
  info.keyFieldsFn ||
  (info.keyFieldsFn = (object, context) => {
    const extract: typeof extractKey = (from, key) => context.readField(key, from);

    const keyObject = (context.keyObject = collectSpecifierPaths(specifier, (schemaKeyPath) => {
      let extracted = extractKeyPath(
        context.storeObject,
        schemaKeyPath,
        // Using context.readField to extract paths from context.storeObject
        // allows the extraction to see through Reference objects and respect
        // custom read functions.
        extract
      );

      if (extracted === void 0 && object !== context.storeObject &&
          hasOwn.call(object, schemaKeyPath[0])) {
        // If context.storeObject fails to provide a value for the requested
        // path, fall back to the raw result object, ...
        extracted = extractKeyPath(object, schemaKeyPath, extractKey);
      }

      invariant(extracted !== void 0,
        `Missing field '%s' while extracting keyFields from %s`,
        schemaKeyPath.join("."), object);

      return extracted;
    }));

    return `${context.typename}:${JSON.stringify(keyObject)}`;
  })
);
```

The blog's nested example, `keyFields: ["title", "author", ["name"]]`, means "title, plus
`author.name`". `getSpecifierPaths` turns that flat-with-nesting notation into explicit
paths:

```mermaid
flowchart LR
    SPEC["KeySpecifier<br/>['title', 'author', ['name']]"]:::ext --> GSP["getSpecifierPaths"]:::memo
    GSP --> P1["path: ['title']"]:::store
    GSP --> P2["path: ['author', 'name']"]:::store
    P1 --> EX1["extractKeyPath(storeObject, ['title'], readField)<br/>→ 'Fahrenheit 451'"]:::read
    P2 --> EX2["extractKeyPath(storeObject, ['author','name'], readField)<br/>→ 'Ray Bradbury'<br/><i>readField sees through {__ref}</i>"]:::read
    EX1 --> CSP["collectSpecifierPaths<br/>DeepMerger over<br/>{title:...} then {author:{name:...}}"]:::memo
    EX2 --> CSP
    CSP --> KO["keyObject — insertion order = path order<br/>{ title: 'Fahrenheit 451',<br/>&nbsp; author: { name: 'Ray Bradbury' } }"]:::store
    KO --> OUT["dataId<br/>Book:{&quot;title&quot;:&quot;Fahrenheit 451&quot;,&quot;author&quot;:{&quot;name&quot;:&quot;Ray Bradbury&quot;}}"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

**The specifier's order is part of the cache key.** `collectSpecifierPaths` merges path
fragments in path order into a fresh object, and `JSON.stringify` emits properties in
insertion order, so the specifier order survives into the `dataId` verbatim:

```
keyFields: ["title", "author", ["name"]]
  → Book:{"title":"Fahrenheit 451","author":{"name":"Ray Bradbury"}}
keyFields: ["author", ["name"], "title"]
  → Book:{"author":{"name":"Ray Bradbury"},"title":"Fahrenheit 451"}
```

Two policies that list the same fields in different orders produce **different ids for the
same object**. Reordering a `keyFields` array is a breaking change for any persisted
`extract()` snapshot. Probe section 2 pins the exact strings.

`extractKeyPath` finishes with `normalize`, which recursively **sorts the keys** of any
object it extracted:

```ts
function normalize<T>(value: T): T {
  // Usually the extracted value will be a scalar value, ... but just in case we get an
  // object or an array, we need to do some normalization of the order of (nested) keys.
  if (isNonNullObject(value)) {
    if (isArray(value)) return value.map(normalize) as any;
    return collectSpecifierPaths(Object.keys(value).sort(), (path) => extractKeyPath(value, path)) as T;
  }
  return value;
}
```

So an *object-valued* key field is order-insensitive, while the *specifier itself* is
order-sensitive. That asymmetry is deliberate but surprising.

A missing key field is a **thrown invariant**, not a silent fallback. `StoreWriter` catches
it only when an explicit `dataId` was supplied:

```ts
// cache/inmemory/writeToStore.ts
} catch (e) {
  // If dataId was provided, tolerate failure of policies.identify.
  if (!dataId) throw e;
}
```

### 3.3 Field identity: `getStoreFieldName`

This is the function that turns `feed(type: "top")` into the store key
`feed({"type":"top"})`.

```mermaid
flowchart TB
    IN["getStoreFieldName({ typename, fieldName, field?, args?, variables? })"]:::api
    IN --> POL["policy = getFieldPolicy(typename, fieldName)<br/>keyFn = policy?.keyFn"]:::read
    POL --> HAS{"keyFn &amp;&amp; typename?"}:::read

    HAS -->|"yes"| KLOOP["specifierOrString = keyFn(args, { typename, fieldName, field, variables })"]:::write
    KLOOP --> KARR{"isArray?"}:::write
    KARR -->|"yes"| KCOMP["keyFn = keyArgsFnFromSpecifier(...)<br/>loop"]:::memo
    KCOMP --> KLOOP
    KARR -->|"no"| KSET["storeFieldName = specifierOrString || fieldName"]:::write

    HAS -->|"no"| DEF
    KSET --> UNDEF{"storeFieldName === undefined?"}:::write
    UNDEF -->|"yes"| DEF["field ?<br/>storeKeyNameFromField(field, variables)<br/>: getStoreKeyName(fieldName, args)"]:::write
    UNDEF -->|"no"| FALSE
    DEF --> FALSE{"storeFieldName === false?"}:::write
    FALSE -->|"yes — dynamic keyArgs:false"| RETF["return fieldName"]:::api
    FALSE -->|"no"| PREFIX{"fieldName === fieldNameFromStoreName(storeFieldName)?"}:::read
    PREFIX -->|"yes"| RET1["return storeFieldName"]:::api
    PREFIX -->|"no — custom key lost the prefix"| RET2["return fieldName + ':' + storeFieldName"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

The **prefix repair** at the bottom is what guarantees `fieldNameFromStoreName` is always
invertible:

```ts
// Make sure custom field names start with the actual field.name.value
// of the field, so we can always figure out which properties of a
// StoreObject correspond to which original field names.
return fieldName === fieldNameFromStoreName(storeFieldName) ? storeFieldName
  : fieldName + ":" + storeFieldName;
```

`fieldNameFromStoreName` is a regex prefix match (`/^[_a-z][_0-9a-z]*/i`), so
`feed({"type":"top"})` → `feed`. A `keyArgs` function returning `"weird key"` would break
that inversion, so the result becomes `feed:weird key`. Everything downstream —
`CacheGroup.depend`'s two-level keys, `modify`'s two-level modifier lookup,
`evict({ fieldName })`, `merge`'s short-name dirtying — depends on this invariant.

The default (no `keyArgs`) path is `storeKeyNameFromField` → `getStoreKeyName`, which
serialises arguments with `canonicalStringify` and appends `@directive` info for
`@connection`-style directives. `canonicalStringify` sorting is what makes
`feed(type: "top", limit: 10)` and `feed(limit: 10, type: "top")` the same key.

#### `keyArgs` specifiers

`keyArgsFnFromSpecifier` supports three namespaces in a key path's first segment:

| Prefix | Source | Missing-value behaviour |
| --- | --- | --- |
| `"@directiveName"` | `field.directives` → `argumentsObjectFromField(d, variables)` | Directive absent → omitted from the key. Directive present without args → `null` recorded (presence itself is part of the key). |
| `"$variableName"` | `context.variables` | Variable absent → omitted. |
| anything else | the field's `args` object | Argument absent → omitted. |

```ts
const suffix = JSON.stringify(collected);
// If no arguments were passed to this field, and it didn't have any other
// field key contributions from directives or variables, hide the empty
// :{} suffix from the field key. ...
if (args || suffix !== "{}") { fieldName += ":" + suffix; }
return fieldName;
```

So `keyArgs: ["type"]` on a field called with `feed(type: "top", limit: 10)` produces
`feed:{"type":"top"}` — the `limit` argument no longer partitions the cache, which is the
foundation of every pagination policy. Compare with the default key
`feed({"limit":10,"type":"top"})`. Probe section 3 prints both.

`keyArgs: false` compiles to `simpleKeyArgsFn = (_args, context) => context.fieldName`, so
all argument variants collapse onto the bare field name.

There is one **implicit** `keyArgs` assignment worth memorising:

```ts
if (existing.read && existing.merge) {
  // If we have both a read and a merge function, assume
  // keyArgs:false, because read and merge together can take
  // responsibility for interpreting arguments in and out. ...
  existing.keyFn = existing.keyFn || simpleKeyArgsFn;
}
```

Defining both `read` and `merge` for a field silently turns on `keyArgs: false`. This also
makes `hasKeyArgs(typename, fieldName)` return `true`, which suppresses short-name dirtying
in `EntityStore.merge` ([§2.6](#26-writes-merge-and-storeobjectreconciler)).

#### Where `storeFieldName` is decided, end to end

```mermaid
sequenceDiagram
    autonumber
    participant SW as StoreWriter.processSelectionSet
    participant P as Policies
    participant KE as key-extractor
    participant CS as canonicalStringify

    SW->>P: getStoreFieldName({typename:"Query", fieldName:"feed", field, variables})
    P->>P: getFieldPolicy("Query","feed") → { keyFn? }
    alt keyArgs configured
        P->>KE: keyArgsFnFromSpecifier(["type"])  (memoized by JSON.stringify(spec))
        KE->>KE: collectSpecifierPaths → { type: "top" }
        KE-->>P: 'feed:{"type":"top"}'
    else no keyArgs
        P->>P: storeKeyNameFromField(field, variables)
        P->>CS: canonicalStringify({limit:10, type:"top"})
        CS-->>P: '{"limit":10,"type":"top"}'
        P-->>P: 'feed({"limit":10,"type":"top"})'
    end
    P->>P: prefix check via fieldNameFromStoreName
    P-->>SW: storeFieldName
    SW->>SW: incoming[storeFieldName] = value
```

### 3.4 `readField` — the field read entry point

Every field read in the cache funnels through `Policies.readField`, whether it comes from
`StoreReader`, from a user `read` function, from a `modify` modifier, or from a `keyFields`
extractor.

```ts
public readField<V = StoreValue>(
  options: ReadFieldOptions,
  context: ReadMergeModifyContext
): SafeReadonly<V> | undefined {
  const objectOrReference = options.from;
  if (!objectOrReference) return;
  const nameOrField = options.field || options.fieldName;
  if (!nameOrField) return;

  if (options.typename === void 0) {
    const typename = context.store.getFieldValue<string>(objectOrReference, "__typename");
    if (typename) options.typename = typename;
  }

  const storeFieldName = this.getStoreFieldName(options);
  const fieldName = fieldNameFromStoreName(storeFieldName);
  const existing = context.store.getFieldValue<V>(objectOrReference, storeFieldName);
  const policy = this.getFieldPolicy(options.typename, fieldName);
  const read = policy && policy.read;

  if (read) {
    const readOptions = makeFieldFunctionOptions(
      this, objectOrReference, options, context,
      context.store.getStorage(
        isReference(objectOrReference) ? objectOrReference.__ref : objectOrReference,
        storeFieldName
      )
    );
    // Call read(existing, readOptions) with cacheSlot holding this.cache.
    return cacheSlot.withValue(this.cache, read, [existing, readOptions]) as SafeReadonly<V>;
  }

  return existing;
}
```

```mermaid
flowchart TB
    RFC["readField(options, context)"]:::api --> FROM{"options.from?"}:::read
    FROM -->|"falsy"| U1["return undefined"]:::dirty
    FROM -->|"present"| TN["typename ??= store.getFieldValue(from, '__typename')<br/><i>registers a dependency on __typename</i>"]:::read
    TN --> SFN["storeFieldName = getStoreFieldName(options)"]:::write
    SFN --> GET["existing = store.getFieldValue(from, storeFieldName)<br/><i>maybeDeepFreeze + group.depend</i>"]:::store
    GET --> RD{"field policy has read?"}:::read
    RD -->|"no"| RETE["return existing"]:::api
    RD -->|"yes"| OPTS["build FieldFunctionOptions:<br/>args · fieldName · storeFieldName · field ·<br/>variables · isReference · toReference ·<br/>storage · cache · canRead · readField · mergeObjects"]:::write
    OPTS --> SLOT["cacheSlot.withValue(this.cache, read, [existing, options])"]:::memo
    SLOT --> RV["reactive vars read inside<br/>attach to this cache and<br/>register a dep"]:::memo
    SLOT --> RETR["return read(...) — may be undefined<br/>(counts as a missing field)"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Four properties of this function drive most of the cache's advanced behaviour:

1. **`read` functions run inside the memoized read.** They execute within the `optimism`
   `Entry` for `executeSelectionSet`, so *any* `store.get` they trigger (via `readField`)
   is recorded as a dependency of the enclosing memoized subtree. A cache redirect —
   `read: (_, { args, toReference }) => toReference({ __typename: "Book", id: args.id })` —
   therefore correctly invalidates when the target entity changes. Probe section 12 pins
   this.
2. **`cacheSlot` is how reactive variables find their cache.** `makeVar`'s getter calls
   `cacheSlot.getValue()`; if a cache is present it attaches itself and registers a
   dependency on the variable. Without the slot, a reactive variable read inside a `read`
   function could not know which cache to notify.
3. **`options.storage` is per-`(entity, storeFieldName)` and survives across reads.**
   `Root.storageTrie` (a `Trie<StorageType>`) hands out a stable object identity for the
   path `(idOrObj, ...storeFieldNames)`. This is where `relayStylePagination` keeps its
   cursor bookkeeping.
4. **Returning `undefined` from a `read` function means "missing".** `StoreReader` treats
   `undefined` exactly as it treats an absent store field, producing a `MissingFieldError`
   entry. Returning `null` is a real value.

`normalizeReadFieldOptions` is the adapter that lets `readField` be called in four ways:

```ts
export function normalizeReadFieldOptions(readFieldArgs, objectOrReference, variables) {
  const { 0: fieldNameOrOptions, 1: from, length: argc } = readFieldArgs;
  let options: ReadFieldOptions;
  if (typeof fieldNameOrOptions === "string") {
    options = {
      fieldName: fieldNameOrOptions,
      // Default to objectOrReference only when no second argument was
      // passed for the from parameter, not when undefined is explicitly
      // passed as the second argument.
      from: argc > 1 ? from : objectOrReference,
    };
  } else {
    options = { ...fieldNameOrOptions };
    // Default to objectOrReference only when fieldNameOrOptions.from is
    // actually omitted, rather than just undefined.
    if (!hasOwn.call(options, "from")) { options.from = objectOrReference; }
  }
  if (__DEV__ && options.from === void 0) {
    invariant.warn(`Undefined 'from' passed to readField with arguments %s`, ...);
  }
  if (void 0 === options.variables) { options.variables = variables; }
  return options;
}
```

Both defaulting rules use *arity/own-property* checks rather than `=== undefined`, so
`readField("name", undefined)` is an error you get warned about instead of silently reading
from the current object.

### 3.5 Merge functions

Three layers of configuration can supply a merge function, resolved by
`getMergeFunction(parentTypename, fieldName, childTypename)`:

```mermaid
flowchart LR
    Q["getMergeFunction('Query', 'author', 'Author')"]:::api --> F["1. field policy<br/>typePolicies.Query.fields.author.merge"]:::write
    F -->|"found"| USE["use it"]:::store
    F -->|"not found"| T["2. child type policy<br/>typePolicies.Author.merge"]:::write
    T -->|"found"| USE
    T -->|"not found"| NONE["undefined → no merge<br/>incoming replaces existing<br/><i>(and __DEV__ may warn)</i>"]:::dirty

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Field policies win over type policies. `merge: true` and `merge: false` are compiled to
singleton functions at configuration time:

```ts
const mergeTrueFn: FieldMergeFunction<any> = (existing, incoming, { mergeObjects }) =>
  mergeObjects(existing, incoming);
const mergeFalseFn: FieldMergeFunction<any> = (_, incoming) => incoming;
```

and `runMergeFunction` short-circuits on their **identity**, avoiding the cost of building
a `FieldMergeFunctionOptions` object:

```ts
public runMergeFunction(existing, incoming, { field, typename, merge, path }, context, storage?) {
  const existingData = existing;   // Preserve the value in case `context.overwrite` is set.
  if (merge === mergeTrueFn) {
    // Instead of going to the trouble of creating a full FieldFunctionOptions
    // object and calling mergeTrueFn, we can simply call mergeObjects, ...
    return makeMergeObjectsFunction(context.store)(existing as StoreObject, incoming as StoreObject);
  }
  if (merge === mergeFalseFn) { return incoming; }

  // If cache.writeQuery or cache.writeFragment was called with options.overwrite
  // set to true, we still call merge functions, but the existing data is always
  // undefined, ...
  if (context.overwrite) { existing = void 0; }
  // ... @stream memoization elided ...
  const result = merge(existing, incoming, makeMergeFieldFunctionOptions(/* ... */));
  return result;
}
```

Note that `overwrite: true` does **not** skip merge functions; it blanks `existing` and
passes the original through as `options.existingData`.

#### `mergeObjects`

```ts
function makeMergeObjectsFunction(store: NormalizedCache): MergeObjectsFunction {
  return function mergeObjects(existing, incoming) {
    if (isArray(existing) || isArray(incoming)) {
      throw newInvariantError("Cannot automatically merge arrays");
    }
    if (isNonNullObject(existing) && isNonNullObject(incoming)) {
      const eType = store.getFieldValue(existing, "__typename");
      const iType = store.getFieldValue(incoming, "__typename");
      const typesDiffer = eType && iType && eType !== iType;
      if (typesDiffer) { return incoming; }

      if (isReference(existing) && storeValueIsStoreObject(incoming)) {
        // Update the normalized EntityStore for the entity identified by
        // existing.__ref, preferring/overwriting any fields contributed by the
        // newer incoming StoreObject.
        store.merge(existing.__ref, incoming);
        return existing;
      }
      if (storeValueIsStoreObject(existing) && isReference(incoming)) {
        // Update the normalized EntityStore for the entity identified by
        // incoming.__ref, taking fields from the older existing object only if
        // those fields are not already present in the newer StoreObject ...
        store.merge(existing, incoming.__ref);
        return incoming;
      }
      if (storeValueIsStoreObject(existing) && storeValueIsStoreObject(incoming)) {
        return { ...existing, ...incoming };
      }
    }
    return incoming;
  };
}
```

```mermaid
flowchart TB
    MO["mergeObjects(existing, incoming)"]:::api --> ARR{"either is an array?"}:::read
    ARR -->|"yes"| THROW["throw 'Cannot automatically merge arrays'"]:::dirty
    ARR -->|"no"| OBJ{"both non-null objects?"}:::read
    OBJ -->|"no"| INC["return incoming"]:::store
    OBJ -->|"yes"| TYP{"__typename differs?"}:::read
    TYP -->|"yes"| INC
    TYP -->|"no"| CASE{"shapes"}:::read
    CASE -->|"Ref + StoreObject"| C1["store.merge(existing.__ref, incoming)<br/>return existing (the Reference)"]:::write
    CASE -->|"StoreObject + Ref"| C2["store.merge(existing, incoming.__ref)<br/>return incoming (the Reference)"]:::write
    CASE -->|"StoreObject + StoreObject"| C3["return { ...existing, ...incoming }<br/><i>shallow</i>"]:::store
    CASE -->|"Ref + Ref (same id or not)"| INC

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

The two mixed cases have a **side effect on the store**, writing directly rather than
returning a value to be written. That is why `StoreWriter.applyMerges` has to check
`isReference(applied)` before merging the result again:

```ts
// cache/inmemory/writeToStore.ts
if (isReference(applied)) {
  // Assume References returned by applyMerges have already been merged
  // into the store. See makeMergeObjectsFunction in policies.ts for an
  // example of how this can happen.
  return;
}
```

`mergeObjects` is also **shallow** for the object/object case, so `merge: true` on a
grandparent does not recursively protect grandchildren. Probe section 10 shows
`mergeObjects` deduplicating a `Reference` against a `StoreObject` and shows the shallow
spread losing nothing only because both objects were complete.

### 3.6 `fragmentMatches` — type-condition resolution

Without `possibleTypes`, the rule is trivially strict:

```ts
public fragmentMatches(fragment, typename, result?, variables?): boolean {
  if (!fragment.typeCondition) return true;
  // If the fragment has a type condition but the object we're matching
  // against does not have a __typename, the fragment cannot match.
  if (!typename) return false;
  const supertype = fragment.typeCondition.name.value;
  // Common case: fragment type condition and __typename are the same.
  if (typename === supertype) return true;
  // ... possibleTypes search ...
  return false;
}
```

With `possibleTypes`, the search runs **upwards** over the inverted map:

```mermaid
flowchart TB
    subgraph inv["Why the map is inverted"]
        CFG["possibleTypes: {<br/>&nbsp; Character: ['Jedi', 'Droid'],<br/>&nbsp; Jedi: ['Padawan']<br/>}"]:::ext
        CFG --> MAP["supertypeMap:<br/>Character → {}<br/>Jedi → { Character }<br/>Droid → { Character }<br/>Padawan → { Jedi }"]:::store
    end

    subgraph bfs["fragmentMatches('Character', typename = 'Padawan')"]
        S0["workQueue = [ supertypeSet('Padawan') = { Jedi } ]"]:::read
        S0 --> S1{"does { Jedi } contain 'Character'?"}:::read
        S1 -->|"no"| S2["enqueue supertypeSet('Jedi') = { Character }"]:::read
        S2 --> S3{"does { Character } contain 'Character'?"}:::read
        S3 -->|"yes"| S4["memoize: supertypeSet('Padawan').add('Character')<br/>return true"]:::memo
    end

    subgraph fz["Fuzzy subtypes — writes only"]
        F0["typename unmatched after<br/>the non-fuzzy queue is exhausted"]:::dirty
        F0 --> F1{"result provided AND<br/>selectionSetMatchesResult(fragment, result)?"}:::read
        F1 -->|"no"| F2["return false"]:::dirty
        F1 -->|"yes"| F3["enqueue supertypes of every fuzzy RegExp<br/>that fully matches typename;<br/>__DEV__ warns 'Inferring subtype X of supertype Y'"]:::write
    end

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

Three subtleties:

- **Positive results are memoized; negative results are not.**
  `// Unfortunately, we cannot safely cache negative results, because new possibleTypes
  data could always be added to the Policies class.` A deep interface hierarchy therefore
  pays full BFS cost on every *miss*, forever.
- **Fuzzy subtypes only apply while writing.** `StoreReader` calls `fragmentMatches` with
  no `result` argument, so `needToCheckFuzzySubtypes` is always false there. Read and write
  can therefore disagree about a fuzzy fragment — deliberately, since only the write path
  has a result object to shape-match against.
- **The queue grows during iteration.** `for (let i = 0; i < workQueue.length; ++i)` is an
  explicit BFS with dedup via `workQueue.indexOf(supertypeSet) < 0`, which is a linear scan
  — fine for the small sets that real schemas produce.

`selectionSetMatchesResult` is the shape test used for fuzzy matching. It requires every
non-skipped field of the fragment to be an own property of the result, recursively, and it
maps over arrays:

```ts
// cache/inmemory/helpers.ts
export function selectionSetMatchesResult(selectionSet, result, variables): boolean {
  if (isNonNullObject(result)) {
    return isArray(result) ?
        result.every((item) => selectionSetMatchesResult(selectionSet, item, variables))
      : selectionSet.selections.every((field) => {
          if (isField(field) && shouldInclude(field, variables)) {
            const key = resultKeyNameFromField(field);
            return hasOwn.call(result, key) &&
              (!field.selectionSet ||
                selectionSetMatchesResult(field.selectionSet, result[key], variables));
          }
          // If the selection has been skipped with @skip(true) or @include(false), it
          // should not count against the matching. ...
          return true;
        });
  }
  return false;
}
```

Probe section 13 pins interface/union matching, including the "no `possibleTypes` means no
match" case.

---

## Part 4 — `StoreWriter`

`writeToStore.ts` (967 lines) turns a response-shaped tree into a set of `StoreObject`
patches. Its defining structural choice is that it is **two-phase**: the entire result is
shredded into a staging map first, and only then is anything written to the
`EntityStore`.

```mermaid
flowchart TB
    subgraph phase1["Phase 1 — pure. No store mutation."]
        direction TB
        PSS["processSelectionSet<br/>recursive descent over<br/>(result, selectionSet)"]:::write
        FF["flattenFields<br/>field collection +<br/>@client / @defer flavors"]:::write
        PFV["processFieldValue<br/>arrays, scalars, recursion"]:::write
        ID["policies.identify<br/>→ dataId + keyObject"]:::write
        STAGE["context.incomingById<br/>Map&lt;dataId, {storeObject, mergeTree, fieldNodeSet}&gt;"]:::store
        MT["mergeTree<br/>where merge functions live,<br/>mirroring the result shape"]:::memo

        PSS --> FF --> PSS
        PSS --> PFV --> PSS
        PSS --> ID
        PSS --> STAGE
        PSS --> MT
    end

    subgraph phase2["Phase 2 — effectful. One pass over incomingById."]
        direction TB
        AM["applyMerges<br/>run user merge functions<br/>bottom-up"]:::write
        WARN["__DEV__ warnAboutDataLoss"]:::dirty
        SM["store.merge(dataId, storeObject)<br/>→ dirties CacheGroup"]:::store
        RET["store.retain(ref.__ref)"]:::store
        AM --> WARN --> SM --> RET
    end

    IN["writeToStore(store, options)"]:::api --> phase1 --> phase2 --> OUT["return Reference"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Why two phases matter: a single result can mention the same entity in several places
(`{ me { id name }, admin { id email } }` where both resolve to `User:1`). Staging lets
those contributions be **combined into one `store.merge` call**, so the entity is dirtied
once, with one final value, rather than being written twice and broadcasting an
intermediate state. It also means a write that throws partway through leaves the store
untouched.

### 4.1 `writeToStore` — the driver

```ts
public writeToStore(store, { query, result, dataId, variables, overwrite, extensions }): Reference | undefined {
  const operationDefinition = getOperationDefinition(query)!;
  const merger = makeProcessedFieldsMerger();

  variables = { ...getDefaultValues(operationDefinition), ...variables! };

  const context: WriteContext = {
    store,
    written: {},
    merge<T>(existing: T, incoming: T) { return merger.merge(existing, incoming) as T; },
    variables: variables as OperationVariables,
    varString: canonicalStringify(variables),
    ...extractFragmentContext(query, this.fragments),
    overwrite: !!overwrite,
    incomingById: new Map(),
    clientOnly: false,
    deferred: false,
    flavors: new Map(),
    extensions,
  };

  const ref = this.processSelectionSet({
    result: result || {}, dataId,
    selectionSet: operationDefinition.selectionSet,
    mergeTree: { map: new Map() }, context, path: [],
  });

  if (!isReference(ref)) { throw newInvariantError(`Could not identify object %s`, result); }
  // ... phase 2, below ...
  store.retain(ref.__ref);
  return ref;
}
```

Field-by-field, `WriteContext` is the whole design:

| Field | Purpose | Lifetime |
| --- | --- | --- |
| `store` | Destination `NormalizedCache`. Read during phase 1 (for `__typename` inference and `readField`), written only in phase 2. | write |
| `written` | `{ [dataId]: SelectionSetNode[] }` — the cycle breaker. | write |
| `merge` | One shared `DeepMerger`. Its `pastCopies` set means an object copied once during this write is mutated in place afterwards. | write |
| `variables` / `varString` | Operation variables with defaults applied, plus their canonical serialisation (used by `isFresh`). | write |
| `fragmentMap` / `lookupFragment` | Fragments defined in the document, plus the `FragmentRegistry` fallback. | write |
| `overwrite` | `writeQuery({ overwrite: true })`. Blanks `existing` inside merge functions and disables the data-loss warning. | write |
| `incomingById` | The staging map. | write |
| `clientOnly` / `deferred` / `flavors` | Directive state, propagated down the tree. `flavors` interns the at-most-four context variants. | write |
| `extensions` | Server extensions, including `@stream` bookkeeping. | write |

The `flavors` map is a small but characteristic optimisation:

```ts
// Since there are only four possible combinations of context.clientOnly and
// context.deferred values, we should need at most four "flavors" of any given
// WriteContext. To avoid creating multiple copies of the same context, we cache
// the contexts in the context.flavors Map ...
function getContextFlavor<TContext extends FlavorableWriteContext>(context, clientOnly, deferred): TContext {
  const key = `${clientOnly}${deferred}`;
  let flavored = context.flavors.get(key);
  if (!flavored) {
    context.flavors.set(key, (flavored =
      context.clientOnly === clientOnly && context.deferred === deferred ? context
      : { ...context, clientOnly, deferred }));
  }
  return flavored as TContext;
}
```

### 4.2 `processSelectionSet` — the recursive core

```mermaid
flowchart TB
    IN["processSelectionSet({ dataId?, result, selectionSet, context, mergeTree, path })"]:::api
    IN --> TYN["typename =<br/>rootTypenamesById[dataId]<br/>?? getTypenameFromResult(result, selectionSet, fragmentMap)<br/>?? store.get(dataId, '__typename')"]:::read
    TYN --> SEED["incoming = {}<br/>if typename is a string: incoming.__typename = typename"]:::store
    SEED --> FLAT["fields = flattenFields(selectionSet, result, context, typename)<br/><i>Map&lt;FieldNode, WriteContext&gt;</i>"]:::write

    FLAT --> LOOP["for each (field, fieldContext)"]:::write
    LOOP --> RK["resultFieldKey = alias ?? field.name<br/>value = result[resultFieldKey]<br/>path = [...path, field.name.value]"]:::read
    RK --> DEF{"value === undefined?"}:::read
    DEF -->|"yes"| MISS["__DEV__ and not @client / @defer /<br/>auto-added __typename / read-function field<br/>→ invariant.error 'Missing field ... while writing result'"]:::dirty
    DEF -->|"no"| SFN["storeFieldName = policies.getStoreFieldName({typename, fieldName, field, variables})"]:::write
    SFN --> CT["childTree = getChildMergeTree(mergeTree, storeFieldName)"]:::memo
    CT --> PFV["incomingValue = processFieldValue(value, field, ctx', childTree, path)<br/><i>ctx' resets clientOnly/deferred when field has a selectionSet</i>"]:::write
    PFV --> CTN["childTypename = readField('__typename', incomingValue)<br/><i>only when field.selectionSet and value is Ref/StoreObject</i>"]:::read
    CTN --> MRG{"policies.getMergeFunction(typename, fieldName, childTypename)"}:::write
    MRG -->|"found"| INFO["childTree.info = { field, typename, merge, path }"]:::memo
    MRG -->|"none, but @stream"| STR["childTree.info = { ..., merge: defaultStreamFieldMergeFn }"]:::memo
    MRG -->|"none"| REC["maybeRecycleChildMergeTree — return the empty tree to the pool"]:::memo
    INFO --> ACC
    STR --> ACC
    REC --> ACC["incoming = context.merge(incoming, { [storeFieldName]: incomingValue })"]:::store
    ACC --> LOOP

    LOOP -->|"done"| IDF["policies.identify(result, { typename, selectionSet, fragmentMap, storeObject: incoming, readField })<br/>dataId ??= id<br/>if keyObject: incoming = context.merge(incoming, keyObject)<br/><i>try/catch: rethrow only if no explicit dataId</i>"]:::write
    IDF --> HASID{"typeof dataId === 'string'?"}:::read
    HASID -->|"no — not normalizable"| RETI["return incoming (inline StoreObject)"]:::api
    HASID -->|"yes"| CYC{"context.written[dataId] already<br/>contains this selectionSet?"}:::read
    CYC -->|"yes"| RETR1["return makeReference(dataId) — cycle broken"]:::api
    CYC -->|"no"| PUSH["written[dataId].push(selectionSet)"]:::store
    PUSH --> FRESH{"reader.isFresh(result, dataRef, selectionSet, context)?"}:::memo
    FRESH -->|"yes"| RETR2["return dataRef — subtree provably unchanged"]:::api
    FRESH -->|"no"| STG["stage into context.incomingById:<br/>merge storeObject, mergeMergeTrees, union fieldNodeSet"]:::store
    STG --> RETR3["return dataRef"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Three details to internalise.

**Typename inference has three sources, in order.** `getTypenameFromResult` scans the
selection set for a `__typename` field (honouring aliases), then falls back to
`result.__typename`, then recurses into fragments. If all of that fails and a `dataId` was
supplied, the *existing store value* is consulted. This is what lets
`cache.writeFragment({ id: "Todo:3", fragment })` work when the fragment has no
`__typename` selection.

**`resultKeyNameFromField` reads the result; `getStoreFieldName` writes the store.** The
alias lives only on the read side:

```ts
const resultFieldKey = resultKeyNameFromField(field);   // alias ?? name  — indexes `result`
const value = result[resultFieldKey];
const storeFieldName = policies.getStoreFieldName({ typename, fieldName: field.name.value, ... });
incoming = context.merge(incoming, { [storeFieldName]: incomingValue });   // indexes the store
```

Aliases therefore never reach the store, and two aliases of the same field with the same
arguments collide onto one `storeFieldName` — deliberately, since they are the same data.

**The directive flavor resets on descent.**

```ts
let incomingValue = this.processFieldValue(
  value, field,
  // Reset context.clientOnly and context.deferred to their default
  // values before processing nested selection sets.
  field.selectionSet ? getContextFlavor(context, false, false) : context,
  childTree, path
);
```

`@client` and `@defer` mark *this* field as locally-resolved or deferred; they do not make
the entire subtree client-only. The reset is why a `@client` field whose sub-selections come
from the server still gets the "Missing field" diagnostic for genuinely absent children.

### 4.3 `flattenFields` — field collection with directive tracking

This implements the GraphQL spec's *CollectFields* with two additions.

```ts
private flattenFields<TContext extends ...>(
  selectionSet, result, context,
  typename = getTypenameFromResult(result, selectionSet, context.fragmentMap)
): Map<FieldNode, TContext> {
  const fieldMap = new Map<FieldNode, TContext>();
  const { policies } = this.cache;

  const limitingTrie = new Trie<{ visited?: boolean }>(false);  // No need for WeakMap, since limitingTrie does not escape.

  (function flatten(this: void, selectionSet, inheritedContext) {
    const visitedNode = limitingTrie.lookup(
      selectionSet,
      // Because we take inheritedClientOnly and inheritedDeferred into
      // consideration here (in addition to selectionSet), it's possible for
      // the same selection set to be flattened more than once, ...
      inheritedContext.clientOnly,
      inheritedContext.deferred
    );
    if (visitedNode.visited) return;
    visitedNode.visited = true;

    selectionSet.selections.forEach((selection) => {
      if (!shouldInclude(selection, context.variables)) return;

      let { clientOnly, deferred } = inheritedContext;
      if (!(clientOnly && deferred) && isNonEmptyArray(selection.directives)) {
        selection.directives.forEach((dir) => {
          const name = dir.name.value;
          if (name === "client") clientOnly = true;
          if (name === "defer") {
            const args = argumentsObjectFromField(dir, context.variables);
            // The @defer directive takes an optional args.if boolean argument, ...
            // Note that @defer(if: false) does not make context.deferred false, but
            // instead behaves as if there was no @defer directive.
            if (!args || (args as { if?: boolean }).if !== false) { deferred = true; }
          }
        });
      }

      if (isField(selection)) {
        const existing = fieldMap.get(selection);
        if (existing) {
          // If this field has been visited along another recursive path
          // before, the final context should have clientOnly or deferred set
          // to true only if *all* paths have the directive (hence the &&).
          clientOnly = clientOnly && existing.clientOnly;
          deferred = deferred && existing.deferred;
        }
        fieldMap.set(selection, getContextFlavor(context, clientOnly, deferred));
      } else {
        const fragment = getFragmentFromSelection(selection, context.lookupFragment);
        if (!fragment && selection.kind === Kind.FRAGMENT_SPREAD) {
          throw newInvariantError(`No fragment named %s`, selection.name.value);
        }
        if (fragment && policies.fragmentMatches(fragment, typename, result, context.variables)) {
          flatten(fragment.selectionSet, getContextFlavor(context, clientOnly, deferred));
        }
      }
    });
  })(selectionSet, context);

  return fieldMap;
}
```

```mermaid
flowchart TB
    subgraph trie["limitingTrie — the visited set"]
        K["key = (selectionSet, clientOnly, deferred)"]:::memo
        K --> N["node.visited"]:::memo
        NOTE["The spec dedupes on fragment name.<br/>Apollo dedupes on selectionSet identity<br/>(1:1 with the name) plus directive state,<br/>because the same fragment may be spread<br/>once inside @client and once outside."]:::ext
    end

    subgraph result["Output: Map&lt;FieldNode, WriteContext&gt;"]
        M1["FieldNode is the map key,<br/>so the SAME field spread through two<br/>fragments appears once"]:::store
        M2["Its context is the AND of all paths:<br/>clientOnly only if every path was @client"]:::store
    end

    subgraph skip["Directive handling"]
        S1["@skip / @include<br/>evaluated by shouldInclude —<br/>excluded fields never enter the map"]:::dirty
        S2["@client → clientOnly = true"]:::write
        S3["@defer → deferred = true,<br/>unless @defer(if: false)"]:::write
    end

    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

The `clientOnly = clientOnly && existing.clientOnly` conjunction only affects diagnostics:
`clientOnly`/`deferred` suppress the "Missing field" error, so a field that is required on
*some* path must still be present.

Note the asymmetry with the reader: `StoreWriter.flattenFields` passes `result` and
`variables` to `fragmentMatches` (enabling fuzzy subtype inference), while
`StoreReader.execSelectionSetImpl` calls `policies.fragmentMatches(fragment, typename)`
with neither.

### 4.4 `processFieldValue` — scalars, arrays, recursion

```ts
private processFieldValue(value, field, context, mergeTree, path): StoreValue {
  if (!field.selectionSet || value === null) {
    // In development, we need to clone scalar values so that they can be
    // safely frozen with maybeDeepFreeze in readFromStore.ts. In production,
    // it's cheaper to store the scalar values directly in the cache.
    return __DEV__ ? cloneDeep(value) : value;
  }

  if (isArray(value)) {
    return value.map((item, i) => {
      const value = this.processFieldValue(item, field, context, getChildMergeTree(mergeTree, i), [...path, i]);
      maybeRecycleChildMergeTree(mergeTree, i);
      return value;
    });
  }

  return this.processSelectionSet({ result: value, selectionSet: field.selectionSet, context, mergeTree, path });
}
```

Three consequences:

- **A leaf field's value is stored by reference in production and deep-cloned in
  development.** The clone exists so `maybeDeepFreeze` on the read side cannot freeze an
  object the caller still holds. Probe section 15 confirms the caller's input object is not
  aliased into the store.
- **Arrays are not entities.** They are stored as plain arrays whose elements may be
  `Reference`s. There is no array identity in the store, which is exactly why paginated
  list fields need a `merge` function: without one, `EntityStore.merge`'s reconciler
  replaces the whole array.
- **`mergeTree` mirrors the result shape, including array indices.** `getChildMergeTree`
  keys on `string | number`, and `path` accumulates numeric indices, so a merge function
  configured on `Query.feed` receives a `path` like `["feed"]` while its nested object
  merges see `["feed", 3, "author"]`.

`emptyMergeTreePool` is a free list. Empty child trees are returned to it after each array
element and after each field with no merge function, so a large result does not allocate a
`{ info, map }` pair per node:

```ts
const emptyMergeTreePool: MergeTree[] = [];
function getChildMergeTree({ map }: MergeTree, name: string | number): MergeTree {
  if (!map.has(name)) { map.set(name, emptyMergeTreePool.pop() || { map: new Map() }); }
  return map.get(name)!;
}
function maybeRecycleChildMergeTree({ map }: MergeTree, name: string | number) {
  const childTree = map.get(name);
  if (childTree && mergeTreeIsEmpty(childTree)) { emptyMergeTreePool.push(childTree); map.delete(name); }
}
```

This is also why `processSelectionSet` stores `mergeTree: mergeTreeIsEmpty(mergeTree) ? void 0 : mergeTree`
into `incomingById` — `// empty MergeTrees may be recycled by maybeRecycleChildMergeTree and
reused for entirely different parts of the result tree.`

### 4.5 Identification and the `keyObject` back-channel

```ts
try {
  const [id, keyObject] = policies.identify(result, {
    typename, selectionSet, fragmentMap: context.fragmentMap,
    storeObject: incoming, readField,
  });
  // If dataId was not provided, fall back to the id just generated by policies.identify.
  dataId = dataId || id;
  // Write any key fields that were used during identification, even if
  // they were not mentioned in the original query.
  if (keyObject) { incoming = context.merge(incoming, keyObject); }
} catch (e) {
  // If dataId was provided, tolerate failure of policies.identify.
  if (!dataId) throw e;
}
```

`identify` is called with the **raw result** as `object` and the **partially-built
normalized object** as `storeObject`, so key extraction sees de-aliased values and already-
normalized child `Reference`s. The `keyObject` that comes back is merged into `incoming`,
which is how `Todo:3` ends up with an `id` field in the store even for a query that only
selected `text`.

The local `readField` closure is what makes nested `keyFields` work during a write:

```ts
const readField: ReadFieldFunction = (...args) => {
  const options = normalizeReadFieldOptions(args, incoming, context.variables);
  if (isReference(options.from)) {
    const info = context.incomingById.get(options.from.__ref);
    if (info) {
      const result = policies.readField({ ...options, from: info.storeObject }, context);
      if (result !== void 0) { return result; }
    }
  }
  return policies.readField(options, context);
};
```

Because phase 1 has not written anything yet, `Book.author` is a `Reference` to an entity
that exists only in `incomingById`. Reading `author.name` for a `keyFields: ["author", ["name"]]`
specifier has to consult the staging map first, then fall back to the durable store.

```mermaid
sequenceDiagram
    autonumber
    participant PSS as processSelectionSet(Book)
    participant KE as keyFieldsFn
    participant RFC as readField closure
    participant STG as context.incomingById
    participant ES as EntityStore

    Note over PSS: children already processed —<br/>incoming.author === { __ref: "Author:7" }<br/>but Author:7 is NOT in the store yet
    PSS->>KE: identify(result, { storeObject: incoming, readField })
    KE->>RFC: readField("name", { __ref: "Author:7" })
    RFC->>STG: incomingById.get("Author:7")
    alt staged in this write
        STG-->>RFC: { storeObject: { __typename:"Author", name:"Ray Bradbury" } }
        RFC-->>KE: "Ray Bradbury"
    else not staged (pre-existing entity)
        RFC->>ES: policies.readField(options, context)
        ES-->>RFC: value from the durable store
    end
    KE-->>PSS: dataId + keyObject
```

### 4.6 `MergeTree` and `applyMerges`

A `MergeTree` is a sparse overlay on the result shape recording **where user merge
functions must run**:

```ts
export interface MergeInfo { field: FieldNode; typename: string | undefined; merge: FieldMergeFunction; path: Array<string | number>; }
export interface MergeTree { info?: MergeInfo; map: Map<string | number, MergeTree>; }
```

```mermaid
flowchart TB
    subgraph shape["Result shape"]
        R["ROOT_QUERY"]:::store
        R --> F["feed({...})<br/>[ item0, item1 ]"]:::store
        F --> I0["item 0<br/>→ Post:1"]:::store
        I0 --> C["comments<br/>[ ... ]"]:::store
    end
    subgraph tree["MergeTree for ROOT_QUERY"]
        T0["{ map: { 'feed({...})' → T1 } }"]:::memo
        T1["{ info: { merge: relayStylePagination.merge,<br/>&nbsp; field, typename:'Query', path:['feed'] },<br/>&nbsp; map: {} }"]:::memo
        T0 --> T1
    end
    subgraph tree2["MergeTree for Post:1 (its own incomingById entry)"]
        U0["{ map: { comments → U1 } }"]:::memo
        U1["{ info: { merge: mergeTrueFn, path:['feed',0,'comments'] } }"]:::memo
        U0 --> U1
    end
    NOTE["Each normalized entity gets its own MergeTree<br/>in incomingById. Nesting inside a tree stops at<br/>entity boundaries, because processSelectionSet<br/>starts a fresh tree per entity — but `path` keeps<br/>accumulating across boundaries, so merge functions<br/>see the full response path."]:::ext

    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

`applyMerges` walks that tree **depth-first, children before parents**, so a merge function
always sees children that have already been merged:

```ts
private applyMerges<T extends StoreValue>(mergeTree, existing, incoming: T, context, getStorageArgs?): T | Reference {
  if (mergeTree.map.size && !isReference(incoming)) {
    const e =
      // Items in the same position in different arrays are not
      // necessarily related to each other, so when incoming is an array
      // we process its elements as if there was no existing data.
      (!isArray(incoming) &&
        // Likewise, existing must be either a Reference or a StoreObject
        // in order for its fields to be safe to merge ...
        (isReference(existing) || storeValueIsStoreObject(existing))) ? existing : void 0;

    const i = incoming as StoreObject | StoreValue[];

    // The options.storage objects provided to read and merge functions
    // are derived from the identity of the parent object plus a
    // sequence of storeFieldName strings/numbers ...
    if (e && !getStorageArgs) { getStorageArgs = [isReference(e) ? e.__ref : e]; }

    let changedFields: Map<string | number, StoreValue> | undefined;
    const getValue = (from, name) =>
      isArray(from) ? (typeof name === "number" ? from[name] : void 0)
                    : context.store.getFieldValue(from, String(name));

    mergeTree.map.forEach((childTree, storeFieldName) => {
      const eVal = getValue(e, storeFieldName);
      const iVal = getValue(i, storeFieldName);
      // If we have no incoming data, leave any existing data untouched.
      if (void 0 === iVal) return;
      if (getStorageArgs) { getStorageArgs.push(storeFieldName); }
      const aVal = this.applyMerges(childTree, eVal, iVal, context, getStorageArgs);
      if (aVal !== iVal) { changedFields = changedFields || new Map(); changedFields.set(storeFieldName, aVal); }
      if (getStorageArgs) { invariant(getStorageArgs.pop() === storeFieldName); }
    });

    if (changedFields) {
      // Shallow clone i so we can add changed fields to it.
      incoming = (isArray(i) ? i.slice(0) : { ...i }) as T;
      changedFields.forEach((value, name) => { (incoming as any)[name] = value; });
    }
  }

  if (mergeTree.info) {
    return this.cache.policies.runMergeFunction(existing, incoming, mergeTree.info, context,
      getStorageArgs && context.store.getStorage(...getStorageArgs));
  }

  return incoming;
}
```

Four invariants worth memorising:

1. **Arrays never pair up with existing arrays.** `!isArray(incoming)` guards `e`, so an
   array's elements are merged as if there were no existing data. Positional merging of
   array items is explicitly rejected. Only a merge function on the array field itself can
   do anything smarter.
2. **`getStorageArgs` is a mutable path stack** whose push/pop discipline is asserted with
   `invariant(getStorageArgs.pop() === storeFieldName)`. It builds the `Trie` key that
   `Root.getStorage` uses to hand out a stable `options.storage`.
3. **Copy-on-write.** `incoming` is cloned only if a child merge actually returned something
   different, which keeps identity stable for unchanged subtrees.
4. **`undefined` incoming values are skipped**, so a merge tree node with no corresponding
   incoming data leaves existing data untouched.

Because two `processSelectionSet` visits can contribute to the same entity, their trees are
unioned by `mergeMergeTrees`, which shares structure aggressively:

```ts
function mergeMergeTrees(left, right): MergeTree {
  if (left === right || !right || mergeTreeIsEmpty(right)) return left!;
  if (!left || mergeTreeIsEmpty(left)) return right;
  const info = left.info && right.info ? { ...left.info, ...right.info } : left.info || right.info;
  const needToMergeMaps = left.map.size && right.map.size;
  const map = needToMergeMaps ? new Map() : left.map.size ? left.map : right.map;
  // ... key-wise recursive merge ...
}
```

Note `{ ...left.info, ...right.info }`: when two visits disagree about the merge function,
**the later visit wins**.

### 4.7 The cycle breaker and the `isFresh` short-circuit

```ts
// Avoid processing the same entity object using the same selection
// set more than once. We use an array instead of a Set since most
// entity IDs will be written using only one selection set, so the
// size of this array is likely to be very small, meaning indexOf is
// likely to be faster than Set.prototype.has.
const sets = context.written[dataId] || (context.written[dataId] = []);
if (sets.indexOf(selectionSet) >= 0) return dataRef;
sets.push(selectionSet);

// If we're about to write a result object into the store, but we
// happen to know that the exact same (===) result object would be
// returned if we were to reread the result with the same inputs,
// then we can skip the rest of the processSelectionSet work for
// this object, and immediately return a Reference to it.
if (this.reader && this.reader.isFresh(result, dataRef, selectionSet, context)) {
  return dataRef;
}
```

The first guard is a correctness requirement: a cyclic result (`user.friends[0].friends[0] === user`)
would otherwise recurse forever. The `(dataId, selectionSet)` pair — not `dataId` alone —
is the key, so the same entity written through two different selection sets is processed
twice, as it must be.

The second guard is the **writer consulting the reader's memo**:

```ts
// cache/inmemory/readFromStore.ts
public isFresh(result, parent, selectionSet, context): boolean {
  if (supportsResultCaching(context.store) && this.knownResults.get(result) === selectionSet) {
    const latest = this.executeSelectionSet.peek(selectionSet, parent, context);
    if (latest && result === latest.result) { return true; }
  }
  return false;
}
```

```mermaid
flowchart LR
    W["StoreWriter<br/>about to shred a subtree"]:::write -->|"isFresh(result, ref, selectionSet, context)"| R["StoreReader"]:::read
    R --> KR{"knownResults.get(result) === selectionSet?<br/><i>WeakMap populated by execSelectionSetImpl</i>"}:::memo
    KR -->|"no"| F["false — do the work"]:::dirty
    KR -->|"yes"| PK{"executeSelectionSet.peek(...)<br/>returns an entry whose<br/>.result === result?"}:::memo
    PK -->|"no (dirty or evicted)"| F
    PK -->|"yes"| T["true — return the Reference,<br/>skip the entire subtree"]:::store

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

`peek` is used rather than a normal call so that a stale entry is **not** recomputed and no
dependency is registered. This is the optimisation that makes the extremely common
"write back the object you just read" pattern nearly free — a `readQuery` → mutate one
field → `writeQuery` round trip re-shreds only the changed spine, because every untouched
subtree is `===` to the frozen object the reader handed out.

### 4.8 `warnAboutDataLoss`

```ts
if (__DEV__ && !context.overwrite) {
  const fieldsWithSelectionSets: Record<string, true> = {};
  fieldNodeSet.forEach((field) => { if (field.selectionSet) { fieldsWithSelectionSets[field.name.value] = true; } });
  const hasSelectionSet = (storeFieldName: string) =>
    fieldsWithSelectionSets[fieldNameFromStoreName(storeFieldName)] === true;
  const hasMergeFunction = (storeFieldName: string) => {
    const childTree = mergeTree && mergeTree.map.get(storeFieldName);
    return Boolean(childTree && childTree.info && childTree.info.merge);
  };
  Object.keys(storeObject).forEach((storeFieldName) => {
    // If a merge function was defined for this field, trust that it
    // did the right thing about (not) clobbering data. If the field
    // has no selection set, it's a scalar field, so it doesn't need
    // a merge function (even if it's an object, like JSON data).
    if (hasSelectionSet(storeFieldName) && !hasMergeFunction(storeFieldName)) {
      warnAboutDataLoss(entityRef, storeObject, storeFieldName, context.store);
    }
  });
}
```

The famous *"Cache data may be lost when replacing the X field of a Y object"* warning.
`warnAboutDataLoss` then applies four suppressions before emitting:

```mermaid
flowchart TB
    C["candidate field:<br/>has a selection set, no merge function"]:::dirty --> G1{"existing child is<br/>an object?"}:::read
    G1 -->|"no"| SK["silent"]:::store
    G1 -->|"yes"| G2{"incoming child is<br/>an object?"}:::read
    G2 -->|"no"| SK
    G2 -->|"yes"| G3{"isReference(existing)?"}:::read
    G3 -->|"yes — data lives elsewhere,<br/>replacing a pointer is safe"| SK
    G3 -->|"no"| G4{"equal(existing, incoming)?"}:::read
    G4 -->|"yes"| SK
    G4 -->|"no"| G5{"every key of existing<br/>is present in incoming?"}:::read
    G5 -->|"yes — nothing is actually lost"| SK
    G5 -->|"no"| G6{"already warned for<br/>`${parentType}.${fieldName}`?"}:::read
    G6 -->|"yes"| SK
    G6 -->|"no"| WARN["invariant.warn(...)<br/>module-level `warnings` Set<br/>dedupes for the process lifetime"]:::dirty

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

The warning is purely diagnostic — the clobbering happens regardless. It is also
`// unused in production, and thus should be pruned by any well-configured minifier.`

### 4.9 The full write, end to end

```mermaid
sequenceDiagram
    autonumber
    participant U as caller
    participant IMC as InMemoryCache
    participant SW as StoreWriter
    participant P as Policies
    participant SR as StoreReader
    participant ES as EntityStore.Root
    participant CG as CacheGroup

    U->>IMC: writeQuery({ query, data, variables })
    IMC->>IMC: write({ ...opts, dataId: "ROOT_QUERY", result: data })
    IMC->>IMC: ++txCount  (suppresses broadcasts)
    IMC->>SW: writeToStore(this.data, options)

    rect rgb(253, 230, 138)
    Note over SW,P: PHASE 1 — pure
    SW->>SW: build WriteContext (variables + defaults, varString, fragmentMap)
    loop recursive descent
        SW->>SW: flattenFields → Map<FieldNode, ctx>
        SW->>P: getStoreFieldName(...) per field
        SW->>SW: processFieldValue → recurse / map arrays / cloneDeep scalars
        SW->>P: getMergeFunction(parent, field, child) → mergeTree.info
        SW->>P: identify(result, { storeObject: incoming, readField })
        SW->>SR: isFresh(result, ref, selectionSet, context)?
        SR-->>SW: true → skip subtree
        SW->>SW: stage into incomingById
    end
    end

    rect rgb(220, 252, 231)
    Note over SW,CG: PHASE 2 — effectful
    loop for each staged (dataId, storeObject, mergeTree)
        SW->>SW: applyMerges (children first)
        SW->>P: runMergeFunction(existing, incoming, info, context, storage)
        Note right of P: user merge fn runs here,<br/>may itself call store.merge<br/>via mergeObjects
        SW->>SW: __DEV__ warnAboutDataLoss
        SW->>ES: store.merge(dataId, storeObject)
        ES->>ES: DeepMerger + storeObjectReconciler
        ES->>CG: dirty(dataId, storeFieldName) per changed field
    end
    SW->>ES: store.retain(ref.__ref)
    end

    SW-->>IMC: Reference
    IMC->>IMC: --txCount === 0 && broadcast !== false
    IMC->>IMC: broadcastWatches()
```

### 4.10 Write-path state transitions

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Raw : GraphQL result tree

    Raw --> Flattened : flattenFields<br/>fragments inlined, @skip/@include applied
    Flattened --> Shredded : processFieldValue + processSelectionSet<br/>identifiable children → Reference
    Shredded --> Identified : policies.identify<br/>keyObject merged into incoming

    Identified --> Staged : incomingById.set(dataId, ...)
    Identified --> Inline : no dataId — object stays nested in its parent
    Identified --> Skipped : written[dataId] contains selectionSet<br/>(cycle) OR reader.isFresh (unchanged)

    Staged --> Merged : applyMerges → runMergeFunction
    Merged --> Committed : store.merge(dataId, storeObject)
    Committed --> Dirtied : group.dirty per changed field
    Committed --> Quiet : storeObjectReconciler found deep equality —<br/>no dirty, no broadcast
    Committed --> Retained : store.retain(ref.__ref)

    Dirtied --> [*]
    Quiet --> [*]
    Retained --> [*]
    Inline --> [*]
    Skipped --> [*]
```

---

## Part 5 — `StoreReader`

`readFromStore.ts` is only 507 lines, but it is where the cache earns its performance. It
walks a selection set over the flat store and re-assembles a response tree, memoizing every
subtree and recording every field it touched.

```mermaid
flowchart TB
    ENTRY["diffQueryAgainstStore({ store, query, rootId, variables, returnPartialData })"]:::api
    ENTRY --> VARS["variables = compact(getDefaultValues(getQueryDefinition(query)), variables)<br/>varString = canonicalStringify(variables)"]:::read
    VARS --> CTX["ReadContext = { store, query, policies, variables, varString,<br/>fragmentMap, lookupFragment }"]:::store
    CTX --> ESS["<b>executeSelectionSet</b> (memoized, LRU 50 000)<br/>key = store.makeCacheKey(selectionSet, parentIdOrObject, varString)"]:::memo

    ESS --> IMPL["execSelectionSetImpl"]:::read
    IMPL -->|"field with sub-selection"| ESS
    IMPL -->|"array field"| ESA["<b>executeSubSelectedArray</b> (memoized, LRU 10 000)<br/>key = store.makeCacheKey(fieldNode, arrayIdentity, varString)"]:::memo
    ESA --> AIMPL["execSubSelectedArrayImpl"]:::read
    AIMPL --> ESS
    AIMPL --> ESA

    IMPL -->|"every field read"| PRF["policies.readField → store.getFieldValue<br/>→ group.depend(dataId, storeFieldName)"]:::store

    ESS --> OUT["ExecResult { result, missing? }"]:::read
    OUT --> DIFF["Cache.DiffResult { result, complete, missing }"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

### 5.1 The two memoized functions

```ts
// cache/inmemory/readFromStore.ts
function execSelectionSetKeyArgs(options: ExecSelectionSetOptions): ExecSelectionSetKeyArgs {
  return [options.selectionSet, options.objectOrReference, options.context];
}

this.executeSelectionSet = wrap(
  (options) => {
    const peekArgs = execSelectionSetKeyArgs(options);
    const other = this.executeSelectionSet.peek(...peekArgs);
    if (other) {
      // If we previously read this result with canonization enabled, we can
      // return that canonized result as-is.
      return other;
    }
    maybeDependOnExistenceOfEntity(options.context.store, options.enclosingRef.__ref);
    // Finally, if we didn't find any useful previous results, run the real
    // execSelectionSetImpl method with the given options.
    return this.execSelectionSetImpl(options);
  },
  {
    max: cacheSizes["inMemoryCache.executeSelectionSet"] || defaultCacheSizes["inMemoryCache.executeSelectionSet"],
    keyArgs: execSelectionSetKeyArgs,
    // Note that the parameters of makeCacheKey are determined by the
    // array returned by keyArgs.
    makeCacheKey(selectionSet, parent, context) {
      if (supportsResultCaching(context.store)) {
        return context.store.makeCacheKey(
          selectionSet,
          isReference(parent) ? parent.__ref : parent,
          context.varString
        );
      }
    },
  }
);
```

| | `executeSelectionSet` | `executeSubSelectedArray` |
| --- | --- | --- |
| Default LRU size | 50 000 | 10 000 |
| Cache key | `(selectionSet, parentDataId \| parentObject, varString)` | `(fieldNode, arrayIdentity, varString)` |
| Key stability requires | stable `SelectionSetNode` identity (i.e. `gql` template caching or `DocumentTransform` memoization) | stable **array identity** in the store |
| Returns | `{ result, missing? }`, deep-frozen in `__DEV__` | `{ result, missing? }`, **not** frozen |

Two things to note about the keys.

**`varString`, not `variables`.** Two reads with structurally-equal but distinct variables
objects share one memo entry. This is why `canonicalStringify` sorting matters on the read
side too.

**The array field's key is the array's object identity.** `store.makeCacheKey` is
`CacheGroup.keyMaker.lookupArray`, a `Trie` that mixes `WeakMap` (objects) and `Map`
(primitives), so passing the array itself gives a per-array memo entry that becomes
collectable when the store replaces the array. That is also why
`storeObjectReconciler`'s deep-equality check is load-bearing: if a re-written array is
deeply equal, the store keeps the *old* array object, so the array memo entry survives.

> **Vestigial code.** The `peek` at the top of the `executeSelectionSet` wrapper can never
> return a value. `optimism`'s `recomputeNewValue` sets `entry.value.length = 0` before
> invoking the wrapped function, and `Entry.peek()` requires `value.length === 1`. The
> `peek` and its `keyArgs` used to differ in a `canonizeResults` flag (Apollo Client 3.x);
> with canonization removed, `peekArgs` are identical to the live call's key args, so the
> lookup always finds the entry currently being recomputed and returns `undefined`. A
> re-implementation should not port it.

`supportsResultCaching` is the single switch that disables all of this:

```ts
// cache/inmemory/entityStore.ts
export function supportsResultCaching(store: any): store is EntityStore {
  // When result caching is disabled, store.depend will be null.
  return !!(store instanceof EntityStore && store.group.caching);
}
```

When it returns `false`, `makeCacheKey` returns `undefined`, and `optimism`'s `wrap`
bypasses the `Entry` machinery entirely (`if (key === void 0) return originalFunction.apply(...)`).

### 5.2 `diffQueryAgainstStore`

```ts
public diffQueryAgainstStore<T>({
  store, query, rootId = "ROOT_QUERY", variables, returnPartialData = true,
}: DiffQueryAgainstStoreOptions): Cache.DiffResult<T> {
  const policies = this.config.cache.policies;
  variables = compact(getDefaultValues(getQueryDefinition(query)), variables);
  const rootRef = makeReference(rootId);
  const execResult = this.executeSelectionSet({
    selectionSet: getMainDefinition(query).selectionSet,
    objectOrReference: rootRef,
    enclosingRef: rootRef,
    context: {
      store, query, policies, variables,
      varString: canonicalStringify(variables),
      ...extractFragmentContext(query, this.config.fragments),
    },
  });

  let missing: MissingFieldError | undefined;
  if (execResult.missing) {
    missing = new MissingFieldError(firstMissing(execResult.missing)!, execResult.missing, query, variables);
  }
  const complete = !missing;
  const { result } = execResult;

  return {
    result:
      complete ? result
      : returnPartialData ?
        Object.keys(result).length === 0 ? null : result
      : null,
    complete,
    missing,
  } as Cache.DiffResult<T>;
}
```

```mermaid
flowchart TB
    R["execResult = { result, missing? }"]:::read --> M{"execResult.missing?"}:::read
    M -->|"no"| C1["complete: true<br/>result: the full tree"]:::store
    M -->|"yes"| MFE["missing = new MissingFieldError(<br/>&nbsp; firstMissing(tree), tree, query, variables)"]:::dirty
    MFE --> RP{"returnPartialData?"}:::read
    RP -->|"false"| C2["complete: false<br/><b>result: null</b>"]:::dirty
    RP -->|"true"| EMPTY{"Object.keys(result).length === 0?"}:::read
    EMPTY -->|"yes"| C3["complete: false<br/><b>result: null</b><br/><i>nothing at all was readable</i>"]:::dirty
    EMPTY -->|"no"| C4["complete: false<br/><b>result: partial tree</b>"]:::read

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

`diff` defaults `returnPartialData` to `true`; `InMemoryCache.read` defaults it to `false`,
with the reason spelled out in the source:

```ts
// cache/inmemory/inMemoryCache.ts
const {
  // Since read returns data or null, without any additional metadata
  // about whether/where there might have been missing fields, the
  // default behavior cannot be returnPartialData = true (like it is
  // for the diff method), since defaulting to true would violate the
  // integrity of the T in the return type. ...
  returnPartialData = false,
} = options;
```

`firstMissing` extracts a human-readable headline from the `MissingTree` by abusing
`JSON.stringify`'s replacer as a visitor:

```ts
function firstMissing(tree: MissingTree): string | undefined {
  try {
    JSON.stringify(tree, (_, value) => { if (typeof value === "string") throw value; return value; });
  } catch (result) { return result as string; }
}
```

### 5.3 `execSelectionSetImpl`

```mermaid
flowchart TB
    IN["execSelectionSetImpl({ selectionSet, objectOrReference, enclosingRef, context })"]:::api
    IN --> DANG{"isReference(obj) AND<br/>not a root id AND<br/>!store.has(obj.__ref)?"}:::read
    DANG -->|"yes"| DRET["return { result: {},<br/>missing: 'Dangling reference to missing X object' }<br/><i>store.has registered a __exists dependency</i>"]:::dirty
    DANG -->|"no"| TN["typename = store.getFieldValue(obj, '__typename')<br/>objectsToMerge = []<br/>if typename and not a root typename:<br/>&nbsp; objectsToMerge.push({ __typename })"]:::read

    TN --> WS["workSet = new Set(selectionSet.selections)"]:::store
    WS --> FE["workSet.forEach(selection)"]:::read
    FE --> SI{"shouldInclude(selection, variables)?"}:::read
    SI -->|"no — @skip/@include"| FE
    SI -->|"yes"| KIND{"isField(selection)?"}:::read

    KIND -->|"no — fragment"| FR["fragment = getFragmentFromSelection(selection, lookupFragment)<br/>throw if a named spread is unresolvable<br/>if policies.fragmentMatches(fragment, typename):<br/>&nbsp; <b>workSet.add(...fragment.selections)</b><br/><i>Set.forEach visits them in this same loop</i>"]:::write
    FR --> FE

    KIND -->|"yes"| RF["fieldValue = policies.readField({ fieldName, field, variables, from: obj }, context)<br/>resultName = alias ?? fieldName"]:::store
    RF --> UND{"fieldValue === undefined?"}:::read
    UND -->|"yes"| MISSING["record missing[resultName] =<br/>&quot;Can't find field 'x' on Y object&quot;<br/><i>unless __typename was auto-added</i>"]:::dirty
    UND -->|"no"| ARR{"isArray(fieldValue)?"}:::read
    ARR -->|"yes, length &gt; 0"| SUB["executeSubSelectedArray({ field, array, enclosingRef, context })"]:::memo
    ARR -->|"no"| SEL{"selection.selectionSet?"}:::read
    SEL -->|"absent — scalar"| KEEP["keep fieldValue as-is"]:::store
    SEL -->|"present and fieldValue != null"| REC["executeSelectionSet({ selectionSet, objectOrReference: fieldValue,<br/>enclosingRef: isReference(fieldValue) ? fieldValue : enclosingRef, context })"]:::memo
    SUB --> PUSH
    KEEP --> PUSH
    REC --> PUSH["if fieldValue !== undefined:<br/>objectsToMerge.push({ [resultName]: fieldValue })"]:::store
    MISSING --> FE
    PUSH --> FE

    FE -->|"done"| MERGE["result = mergeDeepArray(objectsToMerge)"]:::write
    MERGE --> FRZ["frozen = maybeDeepFreeze({ result, missing })<br/>knownResults.set(frozen.result, selectionSet)"]:::memo
    FRZ --> RET["return frozen"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Six things to know precisely.

**`enclosingRef` versus `objectOrReference`.** `objectOrReference` is what we are reading
*from*; `enclosingRef` is the nearest **normalized** ancestor. Non-normalized nested objects
do not have an id of their own, so their existence dependency has to be attributed to the
entity that contains them:

```ts
enclosingRef: isReference(fieldValue) ? fieldValue : enclosingRef,
```

`maybeDependOnExistenceOfEntity(store, enclosingRef.__ref)` runs on every memoized call, so
deleting entity `X` invalidates every memo entry that was reading *inside* `X`, including
subtrees for its inline objects.

**Fragments are flattened by growing the `Set` mid-iteration.**
`fragment.selectionSet.selections.forEach(workSet.add, workSet)` relies on the same
`Set.prototype.forEach` guarantee that `gc()` uses. There is no separate recursion and no
`limitingTrie` here — unlike the writer, the reader has no `@client`/`@defer` state to
track, and duplicate `FieldNode`s are naturally deduped by the `Set`.

**The reader calls `fragmentMatches` with only two arguments.**
`policies.fragmentMatches(fragment, typename)` — no `result`, no `variables` — so fuzzy
subtype inference never happens while reading ([§3.6](#36-fragmentmatches--type-condition-resolution)).

**`undefined` means missing; `null` is a value.** A `read` function returning `undefined`
produces a `MissingFieldError` entry exactly like an absent store field.

**Empty arrays skip the array memo.** `if (fieldValue.length > 0)` — a zero-length array is
passed straight through, avoiding a pointless `Entry`.

**`__typename` is seeded first and can be overwritten.**
`objectsToMerge.push({ __typename: typename })` happens before the field loop, so an
explicitly-selected (or aliased) `__typename` field wins in `mergeDeepArray`.

The final assembly is a left-fold of single-key objects:

```ts
// utilities/internal/mergeDeepArray.ts
export function mergeDeepArray<T>(sources: T[]): T {
  let target = sources[0] || ({} as T);
  const count = sources.length;
  if (count > 1) {
    const merger = new DeepMerger();
    for (let i = 1; i < count; ++i) { target = merger.merge(target, sources[i]); }
  }
  return target;
}
```

Because each source has exactly one key, `DeepMerger` almost always takes its
no-collision branch (`target = shallowCopyForMerge(target); target[key] = source[key]`),
and its `pastCopies` set means only **one** copy is made per result object no matter how
many fields there are. Collisions occur only when two fragments select the same result key,
in which case the values are recursively merged.

### 5.4 `execSubSelectedArrayImpl`

```ts
private execSubSelectedArrayImpl({ field, array, enclosingRef, context }): ExecResult {
  let missing: MissingTree | undefined;
  let missingMerger = new DeepMerger();

  function handleMissing<T>(childResult: ExecResult<T>, i: number): T {
    if (childResult.missing) { missing = missingMerger.merge(missing, { [i]: childResult.missing }); }
    return childResult.result;
  }

  if (field.selectionSet) {
    array = array.filter((item) => item === undefined || context.store.canRead(item));
  }

  array = array.map((item, i) => {
    if (item === null) { return null; }                       // null value in array
    if (isArray(item)) {                                      // This is a nested array, recurse
      return handleMissing(this.executeSubSelectedArray({ field, array: item, enclosingRef, context }), i);
    }
    if (field.selectionSet) {                                 // This is an object, run the selection set on it
      return handleMissing(this.executeSelectionSet({
        selectionSet: field.selectionSet,
        objectOrReference: item,
        enclosingRef: isReference(item) ? item : enclosingRef,
        context,
      }), i);
    }
    if (__DEV__) { assertSelectionSetForIdValue(context.store, field, item); }
    return item;
  });

  return { result: array, missing };
}
```

```mermaid
flowchart TB
    A["array from the store<br/>[ Ref(A), Ref(B-evicted), null, [nested], scalar ]"]:::store
    A --> F{"field.selectionSet?"}:::read
    F -->|"yes"| FILT["<b>filter</b>: keep item if<br/>item === undefined || store.canRead(item)<br/><i>dangling References are dropped —<br/>the array silently shrinks</i>"]:::dirty
    F -->|"no"| MAP
    FILT --> MAP["map each item"]:::read
    MAP --> N1["null → null"]:::store
    MAP --> N2["array → recurse executeSubSelectedArray"]:::memo
    MAP --> N3["object/Reference (with selectionSet)<br/>→ executeSelectionSet"]:::memo
    MAP --> N4["scalar (no selectionSet)<br/>→ pass through<br/>__DEV__: assertSelectionSetForIdValue"]:::store
    N1 --> OUT["{ result: newArray, missing }"]:::read
    N2 --> OUT
    N3 --> OUT
    N4 --> OUT

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

The `canRead` filter is the reason evicting an entity does **not** make queries that list it
incomplete — the item just disappears from the array, and `complete` stays `true`. A
dangling reference in a *singular* field has no such escape hatch, and surfaces as a
`Dangling reference to missing X object` entry from the guard at the top of
`execSelectionSetImpl`. Probe section 13 pins both halves:

```jsonc
// after cache.evict({ id: "Todo:2" }) on a 3-element list field
{
  "rootQueryStillHoldsThreeRefs": 3,      // the store still contains the stale { __ref }
  "readBack": { "todos": [ { "id": 1, … }, { "id": 3, … } ] },
  "complete": true                        // ← no missing-field error
}

// after cache.evict({ id: "Todo:9" }) on a singular field
{
  "complete": false,
  "missing": { "featured": "Dangling reference to missing Todo:9 object" }
}
```

The stale `Reference` is not removed from `ROOT_QUERY.todos` — only `gc()` or an explicit
`cache.modify` will do that. If you need the eviction to be visible to consumers, use a
`read` function or `cache.modify` on the owning field.

Note also that the array's `missing` tree is keyed by **post-filter index**, so a missing
field on the third surviving item is reported at index `2` even if the original array had
five entries.

`assertSelectionSetForIdValue` is a development-only guard that catches a schema/query
mismatch — a `Reference` reached through a field that has no selection set:

```ts
function assertSelectionSetForIdValue(store, field, fieldValue) {
  if (!field.selectionSet) {
    const workSet = new Set([fieldValue]);
    workSet.forEach((value) => {
      if (isNonNullObject(value)) {
        invariant(!isReference(value),
          `Missing selection set for object of type %s returned for query field %s`,
          getTypenameFromStoreObject(store, value), field.name.value);
        Object.values(value).forEach(workSet.add, workSet);
      }
    });
  }
}
```

### 5.5 The missing tree

`MissingTree` is a recursive structure mirroring the result shape, with a string at each
leaf:

```ts
// cache/core/types/common.ts
export type MissingTree = string | { readonly [key: string]: MissingTree };
```

Both `execSelectionSetImpl` and `execSubSelectedArrayImpl` build it with a **dedicated
`DeepMerger`** (`missingMerger`), because the missing tree can collect entries from
multiple fragments and array indices for the same key.

```mermaid
flowchart LR
    subgraph q["Query"]
        QQ["{ todos { id text author { name } } }"]:::ext
    end
    subgraph s["Store — Todo:2 has no author, Author:1 has no name"]
        SS["ROOT_QUERY.todos = [Ref(Todo:1), Ref(Todo:2)]"]:::store
    end
    subgraph m["MissingTree"]
        MT["{ todos: {<br/>&nbsp; 0: { author: { name: &quot;Can't find field 'name' on Author:1 object&quot; } },<br/>&nbsp; 1: { author: &quot;Can't find field 'author' on Todo:2 object&quot; }<br/>} }"]:::dirty
    end
    subgraph e["MissingFieldError"]
        ME["message = firstMissing(tree)<br/>path    = the whole tree<br/>missing = the whole tree<br/>query, variables"]:::dirty
    end
    q --> s --> m --> e

    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

`MissingFieldError`'s constructor accepts either a tree or an array path and normalises to a
tree:

```ts
if (Array.isArray(this.path)) {
  this.missing = this.message;
  for (let i = this.path.length - 1; i >= 0; --i) { this.missing = { [this.path[i]]: this.missing }; }
} else {
  this.missing = this.path;
}
// We're not using `Object.setPrototypeOf` here as it isn't fully supported on Android ...
(this as any).__proto__ = MissingFieldError.prototype;
```

Probe section 5 pins the exact strings, including the dangling-reference message.

### 5.6 Immutability and `knownResults`

```ts
const result = mergeDeepArray(objectsToMerge);
const finalResult: ExecResult = { result, missing };
const frozen = maybeDeepFreeze(finalResult);

// Store this result with its selection set so that we can quickly
// recognize it again in the StoreReader#isFresh method.
if (frozen.result) { this.knownResults.set(frozen.result, selectionSet); }

return frozen;
```

`maybeDeepFreeze` is a no-op outside `__DEV__`, but the contract holds in both builds:
`InMemoryCache.assumeImmutableResults = true`, so **callers must never mutate a read
result.** The freeze in development is what turns a violation into a `TypeError` instead of
silent cache corruption. Probe section 15 verifies that the root object, nested child
objects, and arrays are all frozen.

`knownResults` is a `WeakMap<result, SelectionSetNode>` and is the read side of the
`isFresh` handshake described in [§4.7](#47-the-cycle-breaker-and-the-isfresh-short-circuit).
It is `Weak` so a discarded result does not pin its selection set.

### 5.7 What a read leaves behind

A single `diff` produces two artefacts: the frozen result tree, and a bipartite dependency
graph connecting `optimism` `Entry` objects to `(dataId, storeFieldName)` dep keys.

```mermaid
flowchart TB
    subgraph entries["optimism Entry graph (parent → child via parentEntrySlot)"]
        E0["Entry: maybeBroadcastWatch(watch)"]:::memo
        E1["Entry: executeSelectionSet<br/>(rootSelectionSet, 'ROOT_QUERY', varString)"]:::memo
        E2["Entry: executeSubSelectedArray<br/>(todosFieldNode, arrayObj, varString)"]:::memo
        E3["Entry: executeSelectionSet<br/>(todoSelectionSet, 'Todo:1', varString)"]:::memo
        E4["Entry: executeSelectionSet<br/>(todoSelectionSet, 'Todo:2', varString)"]:::memo
        E0 --> E1 --> E2
        E2 --> E3
        E2 --> E4
    end

    subgraph deps["CacheGroup dep leaves — key = storeFieldName + '#' + dataId"]
        D1["__exists#ROOT_QUERY"]:::store
        D2["todos#ROOT_QUERY"]:::store
        D3["__exists#Todo:1"]:::store
        D4["id#Todo:1"]:::store
        D5["text#Todo:1"]:::store
        D6["__exists#Todo:2"]:::store
        D7["id#Todo:2"]:::store
        D8["text#Todo:2"]:::store
    end

    E1 -.->|depend| D1
    E1 -.->|depend| D2
    E3 -.->|depend| D3
    E3 -.->|depend| D4
    E3 -.->|depend| D5
    E4 -.->|depend| D6
    E4 -.->|depend| D7
    E4 -.->|depend| D8

    W["store.merge('Todo:2', { text: 'changed' })"]:::write
    W ==>|"dirty"| D8
    D8 ==>|"setDirty"| E4
    E4 ==>|"reportDirtyChild"| E2
    E2 ==>|"reportDirtyChild"| E1
    E1 ==>|"reportDirtyChild"| E0

    NOTE["Only E4 recomputes from scratch.<br/>E3 is reused by identity.<br/>E2 and E1 rebuild their spine but reuse<br/>every unchanged child result object."]:::ext

    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

The parent/child edges are wired without any explicit bookkeeping in the cache code. When
`executeSelectionSet` recomputes, `optimism` installs its `Entry` into `parentEntrySlot`;
any nested memoized call reads that slot and registers itself as a child
(`rememberParent`). The cache never says "this subtree depends on that subtree" — it falls
out of the call stack.

Invalidation is likewise two-stage, which is what preserves referential identity:

- `setDirty()` on a leaf marks the owning `Entry` dirty and propagates *"may be dirty"*
  upward (`reportDirtyChild`).
- On the next read, a parent whose children are merely *possibly* dirty recomputes those
  children first. If a child's recomputed value is `===` to what the parent recorded
  (`reportCleanChild` → `valueIs`), the parent is **not** dirtied and returns its cached
  value untouched.

So an edit that a `read` function normalises away — or a write whose value was deeply equal
— stops propagating at the first level where the value stabilises. Probe section 4
demonstrates the identity guarantees: re-reading an unchanged query returns the identical
object; writing an unrelated entity leaves the previous result identical; writing a nested
entity produces a new root object but preserves the identity of untouched siblings.

### 5.8 Reading with `optimistic: true`

The only difference is which store is handed in:

```ts
// cache/inmemory/inMemoryCache.ts
public diff<TData, TVariables>(options) {
  return this.storeReader.diffQueryAgainstStore({
    ...options,
    store: options.optimistic ? this.optimisticData : this.data,
    rootId: options.id || "ROOT_QUERY",
    config: this.config,
  });
}
```

Because `store` is part of the `ReadContext` and `makeCacheKey` delegates to
`context.store.makeCacheKey` — which is `this.group.keyMaker.lookupArray` — **optimistic and
non-optimistic reads land in different `Trie`s and therefore different memo entries**, even
for identical `(selectionSet, parent, varString)` triples. They are also registered in
different `CacheGroup`s, which is what makes the invalidation asymmetry of
[§2.4](#24-cachegroup--the-dependency-graph) work.

```mermaid
flowchart LR
    RD1["diff({ optimistic: true })"]:::api --> S1["store = optimisticData (Stump/Layer)"]:::store
    RD2["diff({ optimistic: false })"]:::api --> S2["store = data (Root)"]:::store
    S1 --> G1["optimistic CacheGroup<br/>keyMaker: Trie #2"]:::memo
    S2 --> G2["root CacheGroup<br/>keyMaker: Trie #1"]:::memo
    G1 --> E1["Entry set A"]:::memo
    G2 --> E2["Entry set B"]:::memo
    NOTE["Same query, same variables →<br/>two independent memo entries and<br/>two independent result objects."]:::ext

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

---

## Part 6 — Reactivity

Parts 2–5 covered storage, naming, writing, and reading. This part covers the machinery
that turns a write into a notification: `watch`, `broadcastWatches`, `txCount`, `batch`,
optimistic layers, and reactive variables.

```mermaid
flowchart TB
    subgraph triggers["Anything that can start a broadcast"]
        T1["write / writeQuery / writeFragment"]:::write
        T2["modify"]:::write
        T3["evict"]:::write
        T4["batch / performTransaction"]:::write
        T5["removeOptimistic"]:::write
        T6["reset (unless discardWatches)"]:::write
        T7["reactive variable assignment"]:::memo
    end

    TX["txCount gate<br/>broadcastWatches() is a no-op while txCount &gt; 0"]:::dirty
    T1 & T2 & T3 & T4 & T6 --> TX
    T5 --> BW
    T7 -->|"getCacheInfo(cache).dep.dirty(rv)<br/>then broadcast(cache)"| BW

    TX --> BW["broadcastWatches(options?)<br/>watches.forEach(c =&gt; maybeBroadcastWatch(c, options))"]:::api
    BW --> MBW["<b>maybeBroadcastWatch</b> — optimism wrap, LRU 5000<br/>key = store.makeCacheKey(query, callback,<br/>canonicalStringify({optimistic, id, variables}))"]:::memo
    MBW -->|"entry clean"| SKIP["nothing happens —<br/>neither diff nor callback runs"]:::store
    MBW -->|"entry dirty"| BWI["broadcastWatch(c, options)"]:::read
    BWI --> D["diff = this.diff(c)<br/><i>c doubles as DiffOptions</i>"]:::read
    D --> OWU{"options.onWatchUpdated?.(c, diff, lastDiff) === false?"}:::read
    OWU -->|"yes"| SUP["suppressed — callback not called"]:::dirty
    OWU -->|"no"| EQ{"!lastDiff || !equal(lastDiff.result, diff.result)"}:::read
    EQ -->|"equal"| SKIP2["no callback — the result did not change"]:::store
    EQ -->|"different"| CB["c.callback((c.lastDiff = diff), lastDiff)"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

There are **three independent gates** between a write and a callback, and understanding
which one fired is the key to debugging "my component did not re-render":

| Gate | Mechanism | Skips |
| --- | --- | --- |
| 1. Memo gate | `maybeBroadcastWatch`'s `optimism` entry is clean | the `diff` **and** the callback |
| 2. `onWatchUpdated` gate | caller returned `false` | the callback |
| 3. Equality gate | `equal(lastDiff.result, diff.result)` | the callback |

Gate 1 is the important one: it is what makes broadcasting proportional to the number of
*affected* watches rather than the number of *registered* watches.

### 6.1 `watch`

```ts
public watch<TData, TVariables>(watch: Cache.WatchOptions<TData, TVariables>): () => void {
  if (!this.watches.size) {
    // In case we previously called forgetCache(this) because this.watches became
    // empty (see below), reattach this cache to any reactive variables on which it
    // previously depended. ...
    recallCache(this);
  }
  this.watches.add(watch);
  if (watch.immediate) { this.maybeBroadcastWatch(watch); }
  return () => {
    // Once we remove the last watch from this.watches, cache.broadcastWatches
    // no longer does anything, so we preemptively tell the reactive variable
    // system to exclude this cache from future broadcasts.
    if (this.watches.delete(watch) && !this.watches.size) { forgetCache(this); }
    // Remove this watch from the LRU cache managed by the maybeBroadcastWatch
    // OptimisticWrapperFunction, to prevent memory leaks involving the closure
    // of watch.callback.
    this.maybeBroadcastWatch.forget(watch);
  };
}
```

```mermaid
stateDiagram-v2
    direction LR
    [*] --> NoWatches : new InMemoryCache()

    NoWatches --> Watching : watch(c) — first one<br/>recallCache(this) reattaches<br/>reactive variables
    Watching --> Watching : watch(c') — subsequent
    Watching --> Watching : unsubscribe(c') — not the last
    Watching --> NoWatches : unsubscribe — last one<br/>forgetCache(this) detaches<br/>reactive variables

    note right of NoWatches
        With no watches, broadcastWatches
        iterates an empty Set, and reactive
        variables stop holding this cache,
        letting it be garbage collected.
    end note
```

The `WatchOptions` object itself is the identity used everywhere: it is the `Set` member,
the `maybeBroadcastWatch` argument, the mutable holder of `lastDiff`, and (via
`makeCacheKey`) part of the memo key through `c.callback`. The comment explains why the
callback is in the key:

```ts
// Different watches can have the same query, optimistic
// status, rootId, and variables, but if their callbacks are
// different, the (identical) result needs to be delivered to
// each distinct callback. ...
c.callback,
```

`maybeBroadcastWatch.forget(watch)` on unsubscribe is a deliberate leak fix: the LRU would
otherwise retain the `Entry`, whose `fn` closes over `watch.callback`, which in a React app
closes over a component.

### 6.2 `broadcastWatch` and the equality gate

```ts
// This method is wrapped by maybeBroadcastWatch, which is called by
// broadcastWatches, so that we compute and broadcast results only when
// the data that would be broadcast might have changed. It would be
// simpler to check for changes after recomputing a result but before
// broadcasting it, but this wrapping approach allows us to skip both
// the recomputation and the broadcast, in most cases.
private broadcastWatch(c: Cache.WatchOptions, options?: BroadcastOptions) {
  const { lastDiff } = c;

  // Both WatchOptions and DiffOptions extend ReadOptions, and DiffOptions
  // currently requires no additional properties, so we can use c (a
  // WatchOptions object) as DiffOptions, without having to allocate a new
  // object, ...
  const diff = this.diff<any>(c);

  if (options) {
    if (c.optimistic && typeof options.optimistic === "string") {
      diff.fromOptimisticTransaction = true;
    }
    if (options.onWatchUpdated && options.onWatchUpdated.call(this, c, diff, lastDiff) === false) {
      // Returning false from the onWatchUpdated callback will prevent
      // calling c.callback(diff) for this watcher.
      return;
    }
  }

  if (!lastDiff || !equal(lastDiff.result, diff.result)) {
    c.callback((c.lastDiff = diff), lastDiff);
  }
}
```

The equality gate matters even though gate 1 exists, because a dirty memo entry does not
imply a changed result. `cache.modify` returning `INVALIDATE`, an evicted field with a
`read` function, or a reactive variable reassigned to an equal-but-not-identical value can
all dirty the entry while producing an identical diff. Probe section 8 shows an
`INVALIDATE` modify dirtying the watch and leaving the delivery count at `1`; probe section
7 shows the same gate absorbing a value-preserving write.

`broadcastWatches` wraps the whole loop in an `onAfterBroadcast` collector:

```ts
protected broadcastWatches(options?: BroadcastOptions) {
  if (!this.txCount) {
    const prevOnAfter = this.onAfterBroadcast;
    const callbacks = new Set<() => void>();
    this.onAfterBroadcast = (cb: () => void) => { callbacks.add(cb); };
    try {
      this.watches.forEach((c) => this.maybeBroadcastWatch(c, options));
      callbacks.forEach((cb) => cb());
    } finally {
      this.onAfterBroadcast = prevOnAfter;
    }
  }
}
```

`ApolloCache.onAfterBroadcast` defaults to `(cb) => cb()`. During a broadcast it is swapped
for a collector so that `watchFragment` observers all emit *after* every watch has been
diffed — otherwise a subscriber reacting to the first fragment could observe a
half-broadcast cache. The base-class comment states the intent: `// Can be overridden by
subclasses to delay calling the provided callback until after all broadcasts have been
completed`.

### 6.3 `txCount` — broadcast batching

`txCount` is a plain counter, incremented by every mutating public method and by `batch`.

```mermaid
sequenceDiagram
    autonumber
    participant U as caller
    participant IMC as InMemoryCache
    participant ES as EntityStore

    Note over IMC: txCount = 0
    U->>IMC: batch({ update })
    IMC->>IMC: ++txCount  → 1
    activate IMC
    IMC->>U: update(cache)
    U->>IMC: writeQuery(A)
    IMC->>IMC: ++txCount → 2
    IMC->>ES: merge
    IMC->>IMC: --txCount → 1, non-zero → NO broadcast
    U->>IMC: writeQuery(B)
    IMC->>IMC: ++txCount → 2
    IMC->>ES: merge
    IMC->>IMC: --txCount → 1, non-zero → NO broadcast
    U->>IMC: evict(C)
    IMC->>IMC: ++txCount → 2 … → 1, NO broadcast
    deactivate IMC
    IMC->>IMC: --txCount → 0
    IMC->>IMC: broadcastWatches(options) — exactly one broadcast
```

Each method's `finally` block follows the same shape:

```ts
try {
  ++this.txCount;
  return this.storeWriter.writeToStore(this.data, options);
} finally {
  if (!--this.txCount && options.broadcast !== false) { this.broadcastWatches(); }
}
```

Note that `broadcast: false` only suppresses the broadcast **that this call would have
triggered**. It does not un-dirty anything, so the next unrelated broadcast will still
deliver the change. It is a batching hint, not a mute button.

### 6.4 `batch` — the transactional API

`InMemoryCache.batch` is the most intricate method in the class. It has three orthogonal
concerns: which layer the update writes to, when the optimistic layer is removed, and how
`onWatchUpdated` interacts with watches that were *already* dirty.

```ts
public batch<TUpdateResult>(options: Cache.BatchOptions<InMemoryCache, TUpdateResult>): TUpdateResult {
  const { update, optimistic = true, removeOptimistic, onWatchUpdated } = options;

  let updateResult: TUpdateResult;
  const perform = (layer?: EntityStore): TUpdateResult => {
    const { data, optimisticData } = this;
    ++this.txCount;
    if (layer) { this.data = this.optimisticData = layer; }
    try {
      return (updateResult = update(this));
    } finally {
      --this.txCount;
      this.data = data;
      this.optimisticData = optimisticData;
    }
  };

  const alreadyDirty = new Set<Cache.WatchOptions>();

  if (onWatchUpdated && !this.txCount) {
    // If an options.onWatchUpdated callback is provided, we want to call it
    // with only the Cache.WatchOptions objects affected by options.update,
    // but there might be dirty watchers already waiting to be broadcast that
    // have nothing to do with the update. ...
    this.broadcastWatches({
      ...options,
      onWatchUpdated(watch) { alreadyDirty.add(watch); return false; },
    });
  }

  if (typeof optimistic === "string") {
    // Note that there can be multiple layers with the same optimistic ID.
    // When removeOptimistic(id) is called for that id, all matching layers
    // will be removed, and the remaining layers will be reapplied.
    this.optimisticData = this.optimisticData.addLayer(optimistic, perform);
  } else if (optimistic === false) {
    // Ensure both this.data and this.optimisticData refer to the root
    // (non-optimistic) layer of the cache during the update. ...
    perform(this.data);
  } else {
    // Otherwise, leave this.data and this.optimisticData unchanged and run
    // the update with broadcast batching.
    perform();
  }

  if (typeof removeOptimistic === "string") {
    this.optimisticData = this.optimisticData.removeLayer(removeOptimistic);
  }
  // ... broadcast, below ...
  return updateResult!;
}
```

#### The three `optimistic` modes

```mermaid
flowchart TB
    subgraph M1["optimistic: string — write into a NEW layer"]
        direction TB
        A1["optimisticData = optimisticData.addLayer(id, perform)"]:::write
        A2["Layer constructor calls replay(this)"]:::memo
        A3["inside perform: this.data = this.optimisticData = layer"]:::store
        A4["every write, modify and evict inside update<br/>lands in the layer, not the Root"]:::store
        A5["finally: data / optimisticData restored"]:::store
        A1 --> A2 --> A3 --> A4 --> A5
        NOTE1["Rollback is free: removeLayer(id).<br/>evict's `limit` is this.data === the layer,<br/>so evictions cannot escape."]:::ext
    end

    subgraph M2["optimistic: false — write into the Root, ignore layers"]
        direction TB
        B1["perform(this.data)"]:::write
        B2["this.data = this.optimisticData = Root"]:::store
        B3["reads inside update see NO optimistic data"]:::read
        B1 --> B2 --> B3
    end

    subgraph M3["optimistic: true (default) — no layer, just batching"]
        direction TB
        C1["perform() with no layer argument"]:::write
        C2["data / optimisticData unchanged"]:::store
        C3["writes go to this.data (the Root);<br/>modify({optimistic:true}) hits the Stump,<br/>which forwards to the Root"]:::store
        C1 --> C2 --> C3
        NOTE3["'optimistic: true' means<br/>'read through the optimistic stack',<br/>NOT 'make this update optimistic'."]:::dirty
    end

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

The `perform` closure being passed as the layer's `replay` function is the crux of
[§2.10](#210-layer-removal-and-replay): `Layer`'s constructor invokes `replay(this)`
immediately, and `Layer.removeLayer` invokes it again whenever a lower layer is removed and
this one must be rebuilt. `perform` reassigns `this.data`/`this.optimisticData` to the layer
each time, so the same update function is re-run against a different parent state.

#### The `alreadyDirty` dance

```mermaid
sequenceDiagram
    autonumber
    participant QM as QueryManager.refetchQueries
    participant IMC as InMemoryCache.batch
    participant W1 as watch A (dirty before the batch)
    participant W2 as watch B (dirtied by the update)

    Note over IMC: onWatchUpdated provided and txCount === 0
    rect rgb(254, 202, 202)
    Note over IMC,W1: Pre-pass — find watches that were ALREADY dirty
    IMC->>IMC: broadcastWatches({ onWatchUpdated: w => { alreadyDirty.add(w)#59; return false } })
    IMC->>W1: maybeBroadcastWatch → dirty → diff computed
    Note right of W1: returns false → no callback,<br/>but the memo entry is now CLEAN<br/>and alreadyDirty = { A }
    IMC->>W2: maybeBroadcastWatch → clean → skipped entirely
    end

    rect rgb(253, 230, 138)
    Note over IMC: Run the update
    IMC->>IMC: perform(...) — dirties watch B
    end

    rect rgb(219, 234, 254)
    Note over IMC,W2: Post-pass — only update-affected watches are dirty now
    IMC->>IMC: broadcastWatches({ onWatchUpdated: wrapped })
    IMC->>W2: dirty → onQueryUpdated(B, diff, lastDiff)
    Note right of W2: not in alreadyDirty, so it is<br/>reported to the caller
    end

    rect rgb(226, 232, 240)
    Note over IMC,W1: Restore
    IMC->>W1: maybeBroadcastWatch.dirty(A)
    Note right of W1: A is silently re-dirtied so it<br/>receives its pending broadcast<br/>the next time, exactly as if<br/>cache.batch had never been called
    end
```

```ts
// Note: if this.txCount > 0, then alreadyDirty.size === 0, so this code
// takes the else branch and calls this.broadcastWatches(options), which
// does nothing when this.txCount > 0.
if (onWatchUpdated && alreadyDirty.size) {
  this.broadcastWatches({
    ...options,
    onWatchUpdated(watch, diff) {
      const result = onWatchUpdated.call(this, watch, diff);
      if (result !== false) {
        // Since onWatchUpdated did not return false, this diff is
        // about to be broadcast to watch.callback, so we don't need
        // to re-dirty it with the other alreadyDirty watches below.
        alreadyDirty.delete(watch);
      }
      return result;
    },
  });
  // Silently re-dirty any watches that were already dirty before the update
  // was performed, and were not broadcast just now.
  if (alreadyDirty.size) {
    alreadyDirty.forEach((watch) => this.maybeBroadcastWatch.dirty(watch));
  }
} else {
  // If alreadyDirty is empty or we don't have an onWatchUpdated
  // function, we don't need to go to the trouble of wrapping
  // options.onWatchUpdated.
  this.broadcastWatches(options);
}
```

This exists so that `client.mutate({ update, onQueryUpdated })` reports **only** the queries
its own `update` function affected, without permanently swallowing unrelated pending
broadcasts. `QueryManager.refetchQueries` is the primary consumer.

`performTransaction` is a thin adapter kept for backwards compatibility:

```ts
public performTransaction(update: (cache: InMemoryCache) => any, optimisticId?: string | null) {
  return this.batch({ update, optimistic: optimisticId || optimisticId !== null });
}
```

Read the `optimistic` expression carefully: a string id passes through; `null` becomes
`false`; `undefined` becomes `true`.

### 6.5 Optimistic lifecycle, end to end

```mermaid
sequenceDiagram
    autonumber
    participant QI as QueryInfo
    participant IMC as InMemoryCache
    participant OD as optimisticData
    participant RT as Root
    participant OQ as ObservableQuery

    rect rgb(253, 230, 138)
    Note over QI,OD: 1. Optimistic response
    QI->>IMC: recordOptimisticTransaction(update, mutationId)
    IMC->>IMC: performTransaction(update, mutationId) → batch({ optimistic: mutationId })
    IMC->>OD: addLayer(mutationId, perform)
    OD->>OD: new Layer(id, parent, replay, group) → replay(layer)
    Note right of OD: markMutationResult writes into the layer
    IMC->>IMC: broadcastWatches()
    IMC->>OQ: callback(diff with fromOptimisticTransaction = true)
    end

    rect rgb(226, 232, 240)
    Note over QI: 2. Network round trip
    end

    rect rgb(219, 234, 254)
    Note over QI,RT: 3. Server response — one atomic batch
    QI->>IMC: cache.batch({ update: writes server data, removeOptimistic: mutationId, onWatchUpdated })
    IMC->>RT: writes land in this.data (the Root)
    IMC->>OD: removeLayer(mutationId)
    OD->>OD: dirty every field the layer shadowed,<br/>rebuild higher layers via replay
    IMC->>IMC: broadcastWatches(options)
    IMC->>OQ: single callback with the reconciled result
    end
```

Two properties follow from doing the write and the layer removal inside **one** `batch`:

- The consumer never observes the intermediate state where the optimistic layer is gone but
  the server data has not landed.
- Exactly one broadcast occurs, so there is one re-render rather than two.

`removeOptimistic` on its own does broadcast unconditionally when the chain changed:

```ts
public removeOptimistic(idToRemove: string) {
  const newOptimisticData = this.optimisticData.removeLayer(idToRemove);
  if (newOptimisticData !== this.optimisticData) {
    this.optimisticData = newOptimisticData;
    this.broadcastWatches();
  }
}
```

There is no `txCount` guard here because `removeLayer` is not itself a mutation of the root
data — but note that if called inside a transaction, `broadcastWatches` still short-circuits
on `txCount`.

Probe section 6 pins the observable layer semantics: stacking, isolation of optimistic
writes from `optimistic: false` reads, and replay-on-removal producing `"server+B"` when
layer A is removed from under layer B.

### 6.6 Reactive variables

`makeVar` creates a function that is both a getter and a setter, plus a small registry
tying variables to caches.

```ts
// cache/inmemory/reactiveVars.ts
export const cacheSlot = new Slot<ApolloCache>();

const cacheInfoMap = new WeakMap<ApolloCache, {
  vars: Set<ReactiveVar<any>>;
  dep: OptimisticDependencyFunction<ReactiveVar<any>>;
}>();

export function makeVar<T>(value: T): ReactiveVar<T> {
  const caches = new Set<ApolloCache>();
  const listeners = new Set<ReactiveListener<T>>();

  const rv: ReactiveVar<T> = function (newValue) {
    if (arguments.length > 0) {
      if (value !== newValue) {
        value = newValue!;
        caches.forEach((cache) => {
          // Invalidate any fields with custom read functions that
          // consumed this variable, so query results involving those
          // fields will be recomputed the next time we read them.
          getCacheInfo(cache).dep.dirty(rv);
          // Broadcast changes to any caches that have previously read
          // from this variable.
          broadcast(cache);
        });
        // Finally, notify any listeners added via rv.onNextChange.
        const oldListeners = Array.from(listeners);
        listeners.clear();
        oldListeners.forEach((listener) => listener(value));
      }
    } else {
      // When reading from the variable, obtain the current cache from
      // context via cacheSlot. This isn't entirely foolproof, but it's
      // the same system that powers varDep.
      const cache = cacheSlot.getValue();
      if (cache) { attach(cache); getCacheInfo(cache).dep(rv); }
    }
    return value;
  };
  // ... onNextChange / attachCache / forgetCache ...
  return rv;
}
```

```mermaid
flowchart TB
    subgraph readpath["Reading a variable inside a field read function"]
        R1["StoreReader.execSelectionSetImpl<br/>(inside an optimism Entry)"]:::memo
        R1 --> R2["policies.readField → cacheSlot.withValue(this.cache, read, ...)"]:::read
        R2 --> R3["user read fn calls myVar()"]:::ext
        R3 --> R4["cacheSlot.getValue() → the cache"]:::memo
        R4 --> R5["rv.attachCache(cache)<br/>caches.add(cache); cacheInfo.vars.add(rv)"]:::store
        R5 --> R6["cacheInfo.dep(rv)<br/>→ registers the enclosing Entry<br/>as a dependent of this variable"]:::memo
    end

    subgraph writepath["Assigning a new value"]
        W1["myVar(next)"]:::write
        W1 --> W2{"value !== newValue?<br/><i>strict identity, not deep equality</i>"}:::read
        W2 -->|"no"| W3["nothing happens at all"]:::store
        W2 -->|"yes"| W4["for each attached cache:<br/>cacheInfo.dep.dirty(rv)"]:::dirty
        W4 --> W5["every memo Entry that read the variable<br/>is marked dirty — transitively up to<br/>maybeBroadcastWatch"]:::dirty
        W5 --> W6["broadcast(cache) → cache.broadcastWatches()"]:::api
        W6 --> W7["onNextChange listeners fire once, then clear"]:::ext
    end

    subgraph attach["Cache attachment lifecycle"]
        A1["watch() with watches.size === 0<br/>→ recallCache(cache)<br/>→ every remembered var re-attaches"]:::store
        A2["last unsubscribe<br/>→ forgetCache(cache)<br/>→ vars drop the cache from their Set"]:::dirty
        A3["cacheInfoMap is a WeakMap, so the<br/>var↔cache memory survives forget<br/>but never pins the cache"]:::ext
    end

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

Four consequences worth stating explicitly:

- **Reactive variables live outside the store.** They are not in `extract()`, they survive
  `reset()` and `restore()`, and they are not garbage collected by `gc()`.
- **The change test is `!==`, not `equal`.** Assigning a structurally-identical new array
  triggers a full invalidation cascade.
- **Attachment happens on read, not on declaration.** A variable that no `read` function has
  ever consumed within a given cache will never broadcast to it. This is why
  `makeVar`-driven UI that bypasses the cache needs `useReactiveVar` rather than a query.
- **`dep.dirty(rv)` and `broadcast(cache)` are separate.** The first invalidates memoized
  reads; the second kicks the watch loop. Both are needed: dirtying alone would leave the
  new value undelivered until something else broadcast.

Probe section 12 shows a `read` function reading a reactive variable, the variable being
reassigned, and the watcher receiving the recomputed field.

### 6.7 `watchFragment` — the observable layer on top of `watch`

`watchFragment` lives in `ApolloCache`, not `InMemoryCache`, and is a fairly thick RxJS
wrapper over `watch`.

```mermaid
flowchart TB
    WF["cache.watchFragment({ fragment, fragmentName, from, variables, optimistic })"]:::api
    WF --> DOC["query = getFragmentDoc(fragment, fragmentName)<br/><i>optimism wrap + WeakCache, LRU 1000 —<br/>guarantees the same (===) DocumentNode</i>"]:::memo
    DOC --> IDS["fromArray.map(toCacheId)<br/>string passes through; otherwise cache.identify<br/>__DEV__ warns when the id is undefined"]:::read
    IDS --> SPLIT{"Array.isArray(from)?"}:::read

    SPLIT -->|"no"| ONE["watchSingleFragment(id, query, options)"]:::read
    ONE --> NULLC{"id === null?"}:::read
    NULLC -->|"yes"| NOBS["nullObservable — a frozen<br/>{ data: null, complete: true } singleton"]:::store
    NULLC -->|"no"| TRIE["fragmentWatches: Trie&lt;{observable?}&gt;<br/>key = [fragmentQuery, canonicalStringify({id, optimistic, variables})]<br/><i>identical watches share ONE observable</i>"]:::memo
    TRIE --> OBS["new Observable(observer =&gt; cache.watch({ ... immediate: true, callback }))<br/>.pipe(distinctUntilChanged(),<br/>&nbsp; share({ connector: ReplaySubject(1),<br/>&nbsp;&nbsp; resetOnRefCountZero: () =&gt; timer(0) }))"]:::memo
    OBS --> EBQ["callback → onAfterBroadcast(() =&gt;<br/>&nbsp; observer.next(getNewestResult(diff)))<br/>getNewestResult reuses currentResult unless<br/><b>equalByQuery</b> says the data changed"]:::read

    SPLIT -->|"yes"| MANY["combineLatestBatched(observables)<br/>.pipe(map(toResult), shareReplay({bufferSize:1, refCount:true}))"]:::memo
    MANY --> AGG["toResult folds into<br/>{ data: [...], complete: AND of all,<br/>&nbsp; dataState, missing: { [idx]: tree } }"]:::read

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

The distinguishing detail is `equalByQuery` rather than `equal`:

```ts
function getNewestResult(diff: Cache.DiffResult<TData>) {
  const data = diff.result;
  if (!currentResult ||
      !equalByQuery(fragmentQuery, { data: currentResult.data }, { data }, options.variables)) {
    currentResult = { data, dataState: diff.complete ? "complete" : "partial", complete: diff.complete } as ...;
    if (diff.missing) { currentResult.missing = diff.missing.missing; }
  }
  return currentResult;
}
```

`equalByQuery` walks the *selection set* rather than the raw objects, and it **ignores
fields marked `@nonreactive`**. So a fragment can opt a field out of triggering updates
while still reading it. Plain `equal` could not express that.

Three more mechanisms in this code that exist purely to avoid redundant work:

- **`fragmentWatches` Trie** dedupes identical `(query, id, optimistic, variables)` watches
  into one shared observable, removed via `this.fragmentWatches.removeArray(cacheKey)` in
  the teardown.
- **`resetOnRefCountZero: () => timer(0)`** debounces teardown so a synchronous
  unsubscribe/resubscribe (React strict mode, or a re-render) does not tear down and rebuild
  the underlying `cache.watch`.
- **`combineLatestBatched`** groups emissions from referentially-equal source observables so
  an array of fragments watching the same entity emits once, not once per element.

---

## Part 7 — Method-by-method reference

Everything below is `ApolloCache`'s surface as `InMemoryCache` implements it. The
classification matters for a re-implementation: **abstract** methods must be written from
scratch, **concrete-inherited** methods come for free and only require the abstract ones to
behave correctly, and **overridden** methods replace a base-class default.

```mermaid
flowchart TB
    subgraph abs["Abstract — must implement (9)"]
        AB["read · write · diff · watch<br/>reset · evict · restore · extract<br/>removeOptimistic · fragmentMatches<br/>performTransaction"]:::api
    end
    subgraph over["Overridden in InMemoryCache (8)"]
        OV["batch · transformDocument · identify<br/>gc · modify · lookupFragment<br/>resolvesClientField · broadcastWatches"]:::write
    end
    subgraph inh["Inherited unchanged from ApolloCache (10)"]
        IN["readQuery · readFragment<br/>writeQuery · writeFragment<br/>updateQuery · updateFragment<br/>watchFragment · recordOptimisticTransaction<br/>transformForLink · onAfterBroadcast"]:::read
    end
    subgraph extra["InMemoryCache-only additions (4)"]
        EX["retain · release · policies · makeVar"]:::store
    end

    inh --> abs
    over --> abs

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
```

The dependency order is strict: implement `write`, `read`/`diff`, `watch`, and
`performTransaction` correctly and the ten inherited methods work automatically, because
each is expressed purely in terms of them.

| Method | Kind | Reduces to | Broadcasts? | `txCount`? |
| --- | --- | --- | --- | --- |
| [`read`](#71-read) | abstract | `storeReader.diffQueryAgainstStore(...).result` | no | no |
| [`diff`](#72-diff) | abstract | `storeReader.diffQueryAgainstStore` | no | no |
| [`write`](#73-write) | abstract | `storeWriter.writeToStore(this.data, …)` | yes | yes |
| [`modify`](#74-modify) | override | `store.modify(id ?? "ROOT_QUERY", fields, false)` | yes | yes |
| [`evict`](#75-evict) | abstract | `optimisticData.evict(options, this.data)` | yes | yes |
| [`watch`](#76-watch) | abstract | `watches.add` + optional immediate broadcast | on `immediate` | no |
| [`batch`](#77-batch--performtransaction) | override | layer juggling + `broadcastWatches` | yes | yes |
| [`performTransaction`](#77-batch--performtransaction) | abstract | `batch` | via `batch` | via `batch` |
| [`recordOptimisticTransaction`](#77-batch--performtransaction) | inherited | `performTransaction(tx, id)` | via `batch` | via `batch` |
| [`removeOptimistic`](#78-removeoptimistic) | abstract | `optimisticData.removeLayer` | yes, if changed | no |
| [`gc`](#79-gc) | override | `optimisticData.gc()` | **no** | reads it |
| [`retain` / `release`](#710-retain--release) | addition | `EntityStore.retain/release` | no | no |
| [`extract`](#711-extract) | abstract | `(optimistic ? optimisticData : data).extract()` | no | no |
| [`restore`](#712-restore) | abstract | `init()` + `data.replace(data)` | no | no |
| [`reset`](#713-reset) | abstract | `init()` + broadcast or discard | yes (default) | no |
| [`identify`](#714-identify) | override | `policies.identify(object)[0]` | no | no |
| [`transformDocument`](#715-transformdocument--transformforlink) | override | fragment registry + `addTypename` | no | no |
| [`transformForLink`](#715-transformdocument--transformforlink) | inherited | identity | no | no |
| [`fragmentMatches`](#716-fragmentmatches--lookupfragment--resolvesclientfield) | abstract | `policies.fragmentMatches(f, t)` | no | no |
| [`lookupFragment`](#716-fragmentmatches--lookupfragment--resolvesclientfield) | override | `config.fragments?.lookup(name)` | no | no |
| [`resolvesClientField`](#716-fragmentmatches--lookupfragment--resolvesclientfield) | override | `!!policies.getReadFunction(t, f)` | no | no |
| [`readQuery` / `readFragment`](#717-the-inherited-convenience-layer) | inherited | `read` | no | no |
| [`writeQuery` / `writeFragment`](#717-the-inherited-convenience-layer) | inherited | `write` | via `write` | via `write` |
| [`updateQuery` / `updateFragment`](#717-the-inherited-convenience-layer) | inherited | `batch(read → update → write)` | once | via `batch` |
| [`watchFragment`](#67-watchfragment--the-observable-layer-on-top-of-watch) | inherited | `watch` + RxJS | via `watch` | no |

---

### 7.1 `read`

```ts
public read<TData>(options: Cache.ReadOptions<TData, OperationVariables>): TData | DeepPartial<TData> | null {
  const { returnPartialData = false } = options;
  return this.storeReader.diffQueryAgainstStore<TData>({
    ...options,
    store: options.optimistic ? this.optimisticData : this.data,
    config: this.config,
    returnPartialData,
  }).result;
}
```

**Data flow.** `options.rootId` (default `"ROOT_QUERY"`) → `makeReference` → memoized
`executeSelectionSet` → deep-frozen result tree. See [Part 5](#part-5--storereader).

**Code flow.** Pure delegation. The only decisions are the store selection and the
`returnPartialData` default flip.

**State transitions.** None in the store, but a read is not side-effect-free: it
**creates memo entries** and **registers dependencies** in the selected `CacheGroup`, and
may **attach reactive variables** to the cache via `cacheSlot`.

**Lifecycle.** Memo entries live in `StoreReader`'s two LRU caches until evicted by size,
dirtied by a write, or discarded wholesale by `resetResultCache()`.

**Sharp edges.**
- `read` discards the missing-field information that `diff` returns. Use `diff` when you
  need to know *what* was missing.
- With `returnPartialData: false` (the default) a single missing field collapses the whole
  result to `null`.
- The returned object is frozen in development and must be treated as immutable in
  production.

---

### 7.2 `diff`

```ts
public diff<TData, TVariables>(options: Cache.DiffOptions<TData, TVariables>): Cache.DiffResult<TData> {
  return this.storeReader.diffQueryAgainstStore({
    ...options,
    store: options.optimistic ? this.optimisticData : this.data,
    rootId: options.id || "ROOT_QUERY",
    config: this.config,
  });
}
```

The same read, exposing `{ result, complete, missing }`. Note the option name change:
`diff` takes `id`, `read` takes `rootId`.

`Cache.DiffResult` also carries `fromOptimisticTransaction`, which is stamped on by
`broadcastWatch` — never by `diff` itself:

```ts
if (c.optimistic && typeof options.optimistic === "string") { diff.fromOptimisticTransaction = true; }
```

**Consumers.** `ObservableQuery.getCacheDiff`, `QueryInfo.markQueryResult` (to capture
`lastDiff` before writing), and `broadcastWatch`.

---

### 7.3 `write`

```ts
public write<TData, TVariables>(options: Cache.WriteOptions<TData, TVariables>): Reference | undefined {
  try {
    ++this.txCount;
    return this.storeWriter.writeToStore(this.data, options);
  } finally {
    if (!--this.txCount && options.broadcast !== false) { this.broadcastWatches(); }
  }
}
```

**Note `this.data`, not `this.optimisticData`.** Writes always target the current "data"
store. Outside a transaction that is the `Root`; inside `batch({ optimistic: "id" })`,
`perform` has temporarily reassigned `this.data` to the new `Layer`, so the same line writes
optimistically. That single indirection is the entire optimistic write mechanism.

**Data flow / code flow.** [Part 4](#part-4--storewriter).

**State transitions.** For each staged entity: `Absent → Present`, `Present → Present`
(dirty), or `Present → PresentSame` (no dirty). Plus `store.retain(ref.__ref)` on the root
id written.

**Lifecycle.** Returns the `Reference` to the root object written, or throws
`Could not identify object` if the top-level result cannot be identified and no `dataId`
was supplied.

**Sharp edges.**
- Writing the same entity through two selection sets in one call merges both contributions
  before a single `store.merge`.
- `overwrite: true` blanks `existing` inside merge functions and suppresses the data-loss
  warning; it does not skip merge functions.
- `broadcast: false` suppresses only this call's broadcast.

---

### 7.4 `modify`

```ts
public modify<Entity>(options: Cache.ModifyOptions<Entity>): boolean {
  if (hasOwn.call(options, "id") && !options.id) {
    // ... we want options.id to default to ROOT_QUERY only when no options.id was
    // provided. If the caller attempts to pass options.id with a falsy/undefined value
    // (perhaps because cache.identify failed), we should not assume the goal was to
    // modify the ROOT_QUERY object. We could throw, but it seems natural to return
    // false to indicate that nothing was modified.
    return false;
  }
  const store = (options.optimistic) ? this.optimisticData : this.data;   // Defaults to false.
  try {
    ++this.txCount;
    return store.modify(options.id || "ROOT_QUERY", options.fields, false);
  } finally {
    if (!--this.txCount && options.broadcast !== false) { this.broadcastWatches(); }
  }
}
```

**Data flow / code flow.** [§2.7](#27-modify--user-controlled-field-surgery).

**Return value semantics.** `true` iff at least one modifier produced a *different* value
(or `DELETE`). `INVALIDATE` returns `false` despite dirtying a dependency. An unknown
`dataId` returns `false` and creates nothing.

**Sharp edges.**
- `optimistic` **defaults to `false`** here, unlike `batch` (`true`) and `watchFragment`
  (`true`).
- `optimistic: true` with no active layers writes to the `Stump`, which forwards to the
  `Root` — i.e. it is *not* isolated. See the sharp-edge note in
  [§2.1](#21-the-layer-chain).
- The `exact` argument is hard-coded `false` here, so `fields.feed` matches every
  `feed(...)` variant. Only `EntityStore.delete(id, fieldName, args)` passes `exact: true`.
- Modifiers see the **store representation**: children are `Reference`s, not nested objects.

---

### 7.5 `evict`

```ts
public evict(options: Cache.EvictOptions): boolean {
  if (!options.id) {
    if (hasOwn.call(options, "id")) {
      // See comment in modify method about why we return false when
      // options.id exists but is falsy/undefined.
      return false;
    }
    options = { ...options, id: "ROOT_QUERY" };
  }
  try {
    ++this.txCount;
    // Pass this.data as a limit on the depth of the eviction, so evictions
    // during optimistic updates (when this.data is temporarily set equal to
    // this.optimisticData) do not escape their optimistic Layer.
    return this.optimisticData.evict(options, this.data);
  } finally {
    if (!--this.txCount && options.broadcast !== false) { this.broadcastWatches(); }
  }
}
```

```mermaid
flowchart TB
    E["evict(options)"]:::api --> ID{"options.id"}:::read
    ID -->|"present but falsy"| F["return false"]:::dirty
    ID -->|"absent"| DEF["id = 'ROOT_QUERY'"]:::store
    ID -->|"truthy"| GO
    DEF --> GO["optimisticData.evict(options, limit = this.data)"]:::write
    GO --> CH["descend Layer → … → limit,<br/>calling delete(id, fieldName, args) at each level"]:::write
    CH --> DRT["group.dirty(id, fieldName || '__exists')<br/><i>unconditional when fieldName was given</i>"]:::dirty
    DRT --> RET["return true iff any level removed data"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

**Argument resolution.** `{ id }` removes the whole entity. `{ id, fieldName }` removes
**every** argument variant of that field, because `EntityStore.modify` is called with
`exact: false`. `{ id, fieldName, args }` resolves one `storeFieldName` via
`policies.getStoreFieldName` and removes exactly that key. Probe section 13 pins all three.

**Sharp edges.**
- Eviction leaves **dangling references** behind. Only `gc()` cleans them up. Reads paper
  over them in list fields ([§5.4](#54-execsubselectedarrayimpl)) but not in singular fields.
- Evicting from `ROOT_QUERY` is how you invalidate a whole query's cached root fields; the
  entities themselves survive until `gc()`.
- The unconditional `group.dirty` when `fieldName` is present exists so that fields backed
  by a `read` function — which have no stored value to remove — still invalidate.

---

### 7.6 `watch`

Covered in [§6.1](#61-watch). Summary of the contract a re-implementation must honour:

| Requirement | Why |
| --- | --- |
| `immediate: true` delivers synchronously, before `watch()` returns | `watchFragment` relies on it to seed `currentResult` |
| The returned unsubscribe is idempotent and detaches reactive variables when the last watch goes | prevents broadcast storms and memory retention |
| `c.lastDiff` is mutated in place by `broadcastWatch` | the equality gate and `ObservableQuery`'s `lastOwnDiff` check both read it |
| A callback is skipped when `equal(lastDiff.result, diff.result)` | otherwise every unrelated write re-renders every component |
| `watch.callback` participates in the broadcast memo key | two watches with identical options but different callbacks must both fire |

---

### 7.7 `batch` / `performTransaction`

Covered in [§6.4](#64-batch--the-transactional-api). The `ApolloCache` base class provides
a default `batch` implemented on top of `performTransaction`:

```ts
// cache/core/cache.ts
public batch<U>(options: Cache.BatchOptions<this, U>): U {
  const optimisticId =
    typeof options.optimistic === "string" ? options.optimistic
    : options.optimistic === false ? null
    : void 0;
  let updateResult: U;
  this.performTransaction(() => (updateResult = options.update(this)), optimisticId);
  return updateResult!;
}
```

`InMemoryCache` overrides it because the base version cannot support `onWatchUpdated` or
`removeOptimistic`. `InMemoryCache.performTransaction` then delegates *back* to the
overridden `batch`, so the two are mutually recursive only in the type system, not at
runtime.

`recordOptimisticTransaction` is inherited unchanged:

```ts
public recordOptimisticTransaction(transaction: Transaction, optimisticId: string) {
  this.performTransaction(transaction, optimisticId);
}
```

`QueryInfo.markMutationOptimistic` is its only in-tree caller.

---

### 7.8 `removeOptimistic`

Covered in [§2.10](#210-layer-removal-and-replay) and [§6.5](#65-optimistic-lifecycle-end-to-end).

**Contract.** Removes **all** layers with the given id (there may be several), replays every
layer above them onto the new parent, dirties every field the removed layers shadowed, and
broadcasts once — but only if the chain actually changed.

**Sharp edge.** Because layers are replayed, the `update` function passed to
`batch({ optimistic: id })` may run an arbitrary number of times. It must be pure and
idempotent, and must not close over mutable external state.

---

### 7.9 `gc`

```ts
public gc(options?: { resetResultCache?: boolean }) {
  canonicalStringify.reset();
  print.reset();
  const ids = this.optimisticData.gc();
  if (options && !this.txCount && options.resetResultCache) { this.resetResultCache(); }
  return ids;
}
```

```mermaid
flowchart TB
    G["gc({ resetResultCache? })"]:::api --> C1["canonicalStringify.reset()<br/>print.reset()<br/><i>global LRUs, not per-cache</i>"]:::memo
    C1 --> C2["ids = optimisticData.gc()<br/>mark &amp; sweep from the TOP of the layer chain,<br/>deleting from the Root"]:::write
    C2 --> C3{"resetResultCache AND txCount === 0?"}:::read
    C3 -->|"no"| RET["return ids"]:::api
    C3 -->|"yes"| C4["resetResultCache():<br/>· addTypenameTransform.resetCache()<br/>· fragments?.resetCaches()<br/>· new StoreReader + new StoreWriter<br/>· new maybeBroadcastWatch<br/>· group.resetCaching() on both CacheGroups"]:::dirty
    C4 --> RET

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

**Sharp edges.**
- **`gc()` never broadcasts.** It deletes entities and dirties `__exists` dependencies, but
  the resulting notifications are only delivered by the *next* broadcast from some other
  operation.
- **Nothing calls `gc()` automatically.** No code in `src/core/**` invokes it. Unreachable
  entities accumulate indefinitely unless the application (or Apollo DevTools) calls it.
- `resetResultCache: true` throws away every memoized read in the cache, so the next read of
  every watched query is a full recomputation. The comment in `StoreReader`'s constructor
  notes this is the intended garbage-collection path for the memo caches:
  `// memoized functions in this class will be "garbage-collected" by recreating the whole
  StoreReader in InMemoryCache.resetResultsCache`.
- It resets **global** caches (`canonicalStringify`, `print`) shared by every cache instance
  in the process.

---

### 7.10 `retain` / `release`

```ts
// Call this method to ensure the given root ID remains in the cache after
// garbage collection, along with its transitive child entities. Note that
// the cache automatically retains all directly written entities. By default,
// the retainment persists after optimistic updates are removed. ...
public retain(rootId: string, optimistic?: boolean): number {
  return (optimistic ? this.optimisticData : this.data).retain(rootId);
}
public release(rootId: string, optimistic?: boolean): number {
  return (optimistic ? this.optimisticData : this.data).release(rootId);
}
```

Retention is a **counter**, so `retain` twice needs `release` twice. `StoreWriter` calls
`store.retain(ref.__ref)` at the end of every write, which is why
`writeFragment({ id: "Book:3" })` makes `Book:3` a gc root until released the same number of
times. `extract()` serialises the non-well-known root ids into `__META.extraRootIds`, and
`replace()` re-retains them, so retention survives a round trip.

---

### 7.11 `extract`

```ts
public extract(optimistic: boolean = false): NormalizedCacheObject {
  return (optimistic ? this.optimisticData : this.data).extract();
}
```

`EntityStore.extract` flattens the layer chain via `toObject()` and appends
`__META.extraRootIds` (sorted, so snapshots are stable). `Layer.toObject` is:

```ts
public toObject(): NormalizedCacheObject {
  return { ...this.parent.toObject(), ...this.data };
}
```

so `extract(true)` gives the flattened optimistic view with layer data shadowing the root.
Tombstones (`undefined` values stored by a layer) survive into the extracted object as
explicit `undefined` properties — a detail that matters if you `JSON.stringify` the result,
since `JSON.stringify` drops them.

---

### 7.12 `restore`

```ts
public restore(data: NormalizedCacheObject): this {
  this.init();
  // Since calling this.init() discards/replaces the entire StoreReader, along
  // with the result caches it maintains, this.data.replace(data) won't have
  // to bother deleting the old data.
  if (data) this.data.replace(data);
  return this;
}
```

```mermaid
sequenceDiagram
    autonumber
    participant U as caller
    participant IMC as InMemoryCache
    participant RT as new Root
    participant SR as new StoreReader

    U->>IMC: restore(snapshot)
    IMC->>IMC: init()
    Note right of IMC: new EntityStore.Root · new Stump<br/>optimisticData = stump<br/><b>all optimistic layers are discarded</b>
    IMC->>SR: resetResultCache() — new StoreReader/StoreWriter,<br/>new maybeBroadcastWatch, group.resetCaching()
    IMC->>RT: data.replace(snapshot)
    RT->>RT: delete ids absent from the snapshot (a no-op on a fresh Root)
    RT->>RT: merge every { dataId: storeObject }
    RT->>RT: __META.extraRootIds.forEach(retain)
    Note over IMC: NO broadcast — watches see stale data<br/>until something else broadcasts
```

**Sharp edges.**
- `restore` does **not** broadcast. `reset` does. If you restore into a cache with live
  watches, you must trigger a broadcast yourself.
- `EntityStore.replace` **merges** rather than assigns. `restore` avoids the union semantics
  by calling `init()` first, but a direct `cache.data.replace(...)` would not.
- Optimistic layers are silently dropped.

---

### 7.13 `reset`

```ts
public reset(options?: Cache.ResetOptions): Promise<void> {
  this.init();
  canonicalStringify.reset();

  if (options && options.discardWatches) {
    // Similar to what happens in the unsubscribe function returned by
    // cache.watch, applied to all current watches.
    this.watches.forEach((watch) => this.maybeBroadcastWatch.forget(watch));
    this.watches.clear();
    forgetCache(this);
  } else {
    // Calling this.init() above unblocks all maybeBroadcastWatch caching, so
    // this.broadcastWatches() triggers a broadcast to every current watcher
    // (letting them know their data is now missing). This default behavior is
    // convenient because it means the watches do not have to be manually
    // reestablished after resetting the cache. ...
    this.broadcastWatches();
  }
  return Promise.resolve();
}
```

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Populated

    Populated --> Emptied : reset() — init() replaces Root, Stump,<br/>StoreReader, StoreWriter, maybeBroadcastWatch
    Emptied --> Rebroadcast : default — broadcastWatches()<br/>every watcher gets an incomplete diff
    Emptied --> Silent : discardWatches: true<br/>forget every watch, clear the Set,<br/>forgetCache(this)

    Rebroadcast --> [*] : watches remain registered
    Silent --> [*] : cache has no watches,<br/>callers must re-subscribe

    note right of Rebroadcast
        Probe section 14: after reset(),
        the watcher receives a diff with
        complete === false.
    end note
```

The `Promise<void>` return exists so subclasses can reset asynchronously;
`InMemoryCache`'s work is entirely synchronous.

---

### 7.14 `identify`

```ts
// Returns the canonical ID for a given StoreObject, obeying typePolicies
// and keyFields (and dataIdFromObject, if you still use that). At minimum,
// the object must contain a __typename and any primary key fields required
// to identify entities of that type. If you pass a query result object, be
// sure that none of the primary key fields have been renamed by aliasing.
// If you pass a Reference object, its __ref ID string will be returned.
public identify(object: StoreObject | Reference): string | undefined {
  if (isReference(object)) return object.__ref;
  try {
    return this.policies.identify(object)[0];
  } catch (e) {
    invariant.warn(e);
  }
}
```

Note the `try/catch`: unlike the write path, a missing key field here **warns and returns
`undefined`** rather than throwing. That is why `watchFragment` has its own explicit
`__DEV__` warning for an unidentifiable `from` — the underlying `identify` already
swallowed the reason.

Calling `cache.identify(obj)` passes no `partialContext`, so `context.storeObject` defaults
to `object` itself and `readField` is bound to the **root** store (`policies.cache["data"]`),
never the optimistic stack.

---

### 7.15 `transformDocument` / `transformForLink`

```ts
public transformDocument(document: DocumentNode): DocumentNode {
  return this.addTypenameTransform.transformDocument(this.addFragmentsToDocument(document));
}
private addFragmentsToDocument(document: DocumentNode) {
  const { fragments } = this.config;
  return fragments ? fragments.transform(document) : document;
}
```

```mermaid
flowchart LR
    D["user DocumentNode"]:::ext --> FR{"config.fragments?"}:::read
    FR -->|"yes"| FT["fragmentRegistry.transform(document)<br/>appends registered fragment definitions<br/>transitively referenced by the document<br/><i>optimism wrap, LRU 2000</i>"]:::memo
    FR -->|"no"| AT
    FT --> AT["addTypenameTransform.transformDocument<br/><i>DocumentTransform, LRU 2000</i>"]:::memo
    AT --> OUT["document with __typename added<br/>to every object selection set"]:::store
    NOTE["Identity stability here is what makes<br/>StoreReader's (selectionSet, …) memo keys work.<br/>Two calls with the same input document must<br/>return the === same output document."]:::ext

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

`addTypenameToDocument.added(field)` is later consulted by both the reader and the writer to
suppress diagnostics for `__typename` fields the cache itself injected — the writer skips
the "Missing field" error, and the reader skips the missing-field entry.

`transformForLink` is the base-class identity function; `InMemoryCache` does not override
it. `QueryManager` calls it before each link request
(`mutation = this.cache.transformForLink(this.transform(mutation))`), so a cache
implementation can strip cache-only additions before the document goes to the server.

---

### 7.16 `fragmentMatches` / `lookupFragment` / `resolvesClientField`

```ts
public fragmentMatches(fragment: InlineFragmentNode | FragmentDefinitionNode, typename: string): boolean {
  return this.policies.fragmentMatches(fragment, typename);
}
public lookupFragment(fragmentName: string): FragmentDefinitionNode | null {
  return this.config.fragments?.lookup(fragmentName) || null;
}
public resolvesClientField(typename: string, fieldName: string): boolean {
  return !!this.policies.getReadFunction(typename, fieldName);
}
```

These three are the cache's contract with subsystems *outside* the cache:

| Method | Consumer | What breaks without it |
| --- | --- | --- |
| `fragmentMatches` | data masking, local resolvers | masking cannot decide whether an inline fragment on an interface applies, so it is effectively disabled — the base class comment says exactly this |
| `lookupFragment` | reader and writer, via `extractFragmentContext` | documents that spread registry-only fragments throw `No fragment named X` |
| `resolvesClientField` | `LocalState` | a `@client` field with a cache `read` function would be set to `null` and warned about, instead of being left `undefined` for the cache to fill in |

---

### 7.17 The inherited convenience layer

All six of these are defined once in `ApolloCache` and inherited unchanged.

```mermaid
flowchart TB
    RQ["readQuery(options, optimistic?)"]:::api --> RD["read({ ...options, rootId: options.id ?? 'ROOT_QUERY', optimistic })"]:::read
    RF["readFragment(options, optimistic?)"]:::api --> GFD["getFragmentDoc(fragment, fragmentName)<br/><i>memoized: WeakCache, LRU 1000</i>"]:::memo
    GFD --> RD2["read({ ...options, query, rootId: id ?? toCacheId(from), optimistic })"]:::read

    WQ["writeQuery({ id, data, ...opts })"]:::api --> WR["write({ ...opts, dataId: id ?? 'ROOT_QUERY', result: data })"]:::write
    WF["writeFragment({ id, from, data, fragment, fragmentName, ...opts })"]:::api --> GFD2["getFragmentDoc(...)"]:::memo
    GFD2 --> WR2["write({ ...opts, query, dataId: id ?? toCacheId(from), result: data })"]:::write

    UQ["updateQuery(options, update)"]:::api --> BAT["batch({ update(cache) {<br/>&nbsp; const value = cache.readQuery(options);<br/>&nbsp; const data = update(value);<br/>&nbsp; if (data == null) return value;<br/>&nbsp; cache.writeQuery({ ...options, data });<br/>&nbsp; return data;<br/>} })"]:::write
    UF["updateFragment(options, update)"]:::api --> BAT2["same shape, with readFragment/writeFragment"]:::write

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

Details that matter:

- **`getFragmentDoc` must be memoized.** It wraps `getFragmentQueryDocument` with
  `wrap(..., { cache: WeakCache, makeCacheKey: bindCacheKey(this) })`. Without a stable
  `===` output document, every `readFragment` would produce a fresh `SelectionSetNode` and
  miss `StoreReader`'s memo entirely. `bindCacheKey(this)` folds the cache instance into the
  key so two caches do not share entries, and the `WeakCache` lets entries die with their
  fragment documents.
- **`writeFragment` with a `dataId` that `identify` cannot derive is still legal.** It
  passes `dataId` explicitly, and `processSelectionSet` catches the `identify` failure
  (`if (!dataId) throw e`).
- **`updateQuery`/`updateFragment` return the *new* data** if the updater produced any, and
  the previously-read value otherwise. Returning `undefined` or `null` from the updater is
  the documented way to abort without writing.
- **`toCacheId`** is `typeof from === "string" ? from : this.identify(from)`, so `from`
  accepts a `StoreObject`, a `Reference`, a masked `FragmentType`, or a raw id string.

---

### 7.18 What `InMemoryCache` deliberately does *not* implement

| Base-class member | `InMemoryCache` behaviour |
| --- | --- |
| `transformForLink` | inherited identity — the cache does not strip anything for the link chain |
| `onAfterBroadcast` | inherited default `(cb) => cb()`, but temporarily replaced by a collector inside `broadcastWatches` |
| `assumeImmutableResults` | overridden to `true` (base default is `false`) |

The `assumeImmutableResults` override is a capability declaration, not a configuration knob:

```ts
// Override the default value, since InMemoryCache result objects are frozen
// in development and expected to remain logically immutable in production.
public readonly assumeImmutableResults = true;
```

It flows outward — `ApolloClient` defaults its own `assumeImmutableResults` option to
`cache.assumeImmutableResults`, and `QueryManager` republishes it as a public readonly
property — but as of 4.2.11 nothing inside `src/` branches on it. Treat it as the cache
advertising its immutability contract to application and integration code rather than as a
switch that changes client behaviour.

---

## Part 8 — The cache in the Apollo Client pipeline

Parts 0–7 treated the cache as a closed system. This part opens the boundary: who calls
which method, in what order, and — most importantly — **which client behaviours are actually
cache behaviours in disguise**. Several things people believe are `InMemoryCache` features
(deduplicated notifications, "the query didn't re-render", `@nonreactive`) live partly or
wholly in `QueryManager` and `ObservableQuery`.

### 8.0 The call map

Every arrow below is a real call site. Nothing else in `src/` touches the cache.

```mermaid
flowchart TB
    subgraph app["Application surface"]
        AC["ApolloClient"]:::ext
        HK["useFragment ·<br/>useSuspenseFragment"]:::ext
    end

    subgraph core["Core orchestration"]
        QM["QueryManager"]:::ext
        OQ["ObservableQuery"]:::ext
        QI["QueryInfo"]:::ext
        LS["LocalState"]:::ext
        MK["maskOperation ·<br/>maskFragment"]:::ext
    end

    subgraph cache["InMemoryCache"]
        RD["read · diff"]:::read
        WR["write"]:::write
        WA["watch"]:::memo
        BA["batch"]:::write
        MU["modify · evict ·<br/>removeOptimistic · reset"]:::dirty
        MI["identify · transformDocument ·<br/>fragmentMatches · lookupFragment ·<br/>resolvesClientField · extract · restore"]:::api
    end

    AC -->|"readQuery/readFragment<br/>writeQuery/writeFragment<br/>watchFragment<br/>extract/restore"| MI
    HK -->|"identify"| MI
    QM -->|"transformDocument (via DocumentTransform)<br/>transformForLink"| MI
    QM -->|"diff — fetchQueryByPolicy.readCache()"| RD
    QM -->|"batch — refetchQueries"| BA
    QM -->|"removeOptimistic · reset"| MU
    OQ -->|"diff — getCacheDiff()"| RD
    OQ -->|"watch — resubscribeCache()"| WA
    OQ -->|"batch — fetchMore"| BA
    QI -->|"diff before/after write"| RD
    QI -->|"writeQuery inside batch"| WR
    QI -->|"recordOptimisticTransaction"| BA
    QI -->|"modify ROOT_MUTATION scrub"| MU
    QI -.->|"wraps evict/modify/reset<br/>to count destructive ops"| MU
    LS -->|"fragmentMatches"| MI
    MK -->|"fragmentMatches · lookupFragment"| MI
    WA -.->|"broadcast callback"| OQ

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

Read the map as three tiers:

| Tier | Members | Cache relationship |
| --- | --- | --- |
| **Owner** | `ApolloClient` | constructs the cache, forwards the convenience API verbatim |
| **Orchestrators** | `QueryManager`, `ObservableQuery`, `QueryInfo` | the only code that writes, watches, and transacts |
| **Consultants** | `LocalState`, masking, `useFragment` | read-only metadata queries (`fragmentMatches`, `lookupFragment`, `identify`) |

### 8.1 Document transforms — what the cache sees is not what you wrote

`QueryManager` wraps `cache.transformDocument` in a `DocumentTransform` and — critically —
disables that transform's own cache:

```ts
const defaultDocumentTransform = new DocumentTransform(
  (document) => this.cache.transformDocument(document),
  // Allow the apollo cache to manage its own transform caches
  { cache: false }
);
```

When a user transform is configured, the default transform runs **twice**, sandwiching it:

```ts
this.documentTransform =
  documentTransform ?
    defaultDocumentTransform
      .concat(documentTransform)
      // The custom document transform may add new fragment spreads or new
      // field selections, so we want to give the cache a chance to run
      // again. For example, the InMemoryCache adds __typename to field
      // selections and fragments from the fragment registry.
      .concat(defaultDocumentTransform)
  : defaultDocumentTransform;
```

This is why §7.15's `transformDocument` must be **idempotent**: the second pass sees a
document that already has `__typename` everywhere and must return it unchanged (and,
because of `addTypenameTransform`'s own memo, return it `===`-identical).

```mermaid
flowchart LR
    U["User document<br/><i>query Q { todo { text } }</i>"]:::ext
    T1["defaultDocumentTransform<br/>= cache.transformDocument<br/><i>fragment registry + __typename</i>"]:::api
    T2["user documentTransform"]:::ext
    T3["defaultDocumentTransform<br/><i>again — idempotent</i>"]:::api
    D["transformed document<br/><i>the cache's key everywhere</i>"]:::store

    U --> T1 --> T2 --> T3 --> D

    D --> GDI["getDocumentInfo(document)<br/><i>AutoCleanedWeakCache, 2000</i>"]:::memo
    GDI --> SQ["serverQuery<br/><i>@client/@connection/@nonreactive/@unmask stripped</i>"]:::ext
    GDI --> CQ["clientQuery"]:::ext
    GDI --> AQ["asQuery<br/><i>mutation/subscription → query</i>"]:::read
    GDI --> NRQ["nonReactiveQuery"]:::ext

    D --> TFL["cache.transformForLink<br/><i>identity for InMemoryCache</i>"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

Two derived documents matter to the cache:

- **`asQuery`** rewrites `operation: "mutation" | "subscription"` to `"query"`. Both
  `StoreReader` and `StoreWriter` call `getOperationDefinition`-style helpers that assume a
  query; `QueryInfo.markMutationResult` passes `asQuery` to `cache.diff` for exactly this
  reason ("The cache complains if passed a mutation where it expects a query").
- **`serverQuery`** strips `@client`, `@connection`, `@nonreactive` and `@unmask` before the
  link chain sees it. The cache never sees `serverQuery` — it always works with the full
  transformed document, which is why `@connection` (Part 3.3) and `@nonreactive`
  (Part 4.3) are cache-visible directives at all.

> **Sharp edge.** The document identity that reaches the cache is the *transformed* one.
> `StoreReader`'s memo keys and `Policies`' `keyArgs` closures are keyed off nodes inside
> it. Two `gql` documents that print identically but are distinct objects produce distinct
> memo entries — `DocumentTransform`'s own `WeakCache` is what normally collapses them.

### 8.2 `ObservableQuery` — the cache's principal client

An `ObservableQuery` holds **exactly one** cache watch at a time, installed by
`resubscribeCache()` and torn down on query/variable change:

```ts
const watch: ObservableQuery.CacheWatchOptions<TData, TVariables> = {
  query,
  variables,
  optimistic: true,
  watcher: this,
  callback: (diff) => { /* ... */ },
};
const cancelWatch = this.cache.watch(watch);
```

`watcher: this` is the extension field referenced throughout Part 6 — it is how
`onWatchUpdated` callbacks in `QueryInfo` and `QueryManager` recognise "is this watch mine?"

Three fetch policies **do not watch at all**:

```ts
const shouldUnsubscribe =
  fetchPolicy === "standby" ||
  fetchPolicy === "no-cache" ||
  this.waitForNetworkResult;
```

`waitForNetworkResult` is initialised to `fetchPolicy === "network-only"` and cleared the
first time a network notification arrives, at which point `resubscribeCache()` runs again.
So a `network-only` query is *invisible to the cache's broadcast* until its first response
lands.

#### The watch callback's four gates

```mermaid
flowchart TB
    CB["callback(diff) from broadcastWatch"]:::memo
    G0{"info.hasClientExports<br/>|| hasForcedResolvers?"}:::dirty
    G0X["watch.lastDiff = undefined<br/><i>defeat the equality gate so future<br/>equal diffs still arrive</i>"]:::dirty
    G1{"watch.lastOwnDiff === diff?"}:::dirty
    G1X["return — this broadcast is<br/>the echo of our own write"]:::dirty
    G2{"!diff.complete AND<br/>(previous.error || previous is<br/>uninitialized/empty)?"}:::dirty
    G2X["return — let the refetch repair<br/>the partial result instead"]:::dirty
    G3{"equal(previousResult.data,<br/>diff.result)?"}:::dirty
    G3X["return — no observable change"]:::dirty
    OK["scheduleNotify()<br/><i>dirty = true; setTimeout(notify, 0)</i>"]:::write

    CB --> G0
    G0 -->|yes| G0X --> G1
    G0 -->|no| G1
    G1 -->|yes| G1X
    G1 -->|no| G2
    G2 -->|yes| G2X
    G2 -->|no| G3
    G3 -->|yes| G3X
    G3 -->|no| OK

    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Gate 0 is a deliberate defeat of the cache's own optimisation. The comment is explicit
about the coupling:

```ts
// This is based on an implementation detail of `InMemoryCache`, which
// is not optimal - but the only alternative to this would be to
// resubscribe to the cache asynchonouly, which would bear the risk of
// missing further synchronous updates.
watch.lastDiff = undefined;
```

Recall from §6.2 that `broadcastWatch` skips the callback when `equal(lastDiff.result,
diff.result)`. A query with `@client @export` variables or forced resolvers may produce a
*different* final result from an *identical* cache diff, so it clears `lastDiff` to force
every future broadcast through.

Gate 1 is the "own write" suppression. `QueryInfo.markQueryResult` stamps
`watch.lastOwnDiff = diff` from inside the `batch`'s `onWatchUpdated`; when the deferred
broadcast then delivers that same `diff` object, the callback drops it by **reference
identity**, not deep equality. The doc comment on the field explains why full suppression
is not an option:

```ts
/**
 * @internal
 * We cannot suppress the broadcast completely, since that would
 * ...
 * Without the `own B` being broadcast, the `cache.watch` would swallow
 * C.
 * So instead we track the last "own diff" and suppress further processing
 * in the callback.
 */
lastOwnDiff?: Cache.DiffResult<TData>;
```

Suppressing the broadcast would leave `watch.lastDiff` stale at `A`, and the *next*
genuine change `C` would be compared against `A` instead of `B`. The watch must see `B` to
keep its equality baseline honest — it just must not act on it.

### 8.3 Fetch policies as a cache-interaction table

`fetchQueryByPolicy` is where a fetch policy becomes concrete cache calls. Its `readCache`
helper is fixed:

```ts
const readCache = () =>
  this.cache.diff<any>({
    query,
    variables,
    returnPartialData: true,
    optimistic: true,
  });
```

Note `returnPartialData: true` unconditionally — the *user's* `returnPartialData` is applied
later in `toResult`, which blanks `data` to `undefined` when `!diff.complete`. The cache is
always asked for everything it has.

| `fetchPolicy` | Reads cache? | Watches cache? | Writes result? | Emission shape |
| --- | --- | --- | --- | --- |
| `cache-first` | yes | yes | `MERGE` | cache alone if `complete`; else cache-then-link when `returnPartialData`, else link only |
| `cache-and-network` | yes | yes | `MERGE` | `concat(cache, link)` when `complete \|\| returnPartialData` |
| `cache-only` | yes | yes | — | cache only, `NetworkStatus.ready` |
| `network-only` | no | **after first result** | `MERGE`/`OVERWRITE` | link only |
| `no-cache` | no | no | `FORBID` | link only |
| `standby` | no | no | — | `EMPTY` |

`CacheWriteBehavior` is chosen once per fetch and threaded into `QueryInfo`:

```ts
const cacheWriteBehavior =
  fetchPolicy === "no-cache" ? CacheWriteBehavior.FORBID
    // Watched queries must opt into overwriting existing data on refetch,
    // by passing refetchWritePolicy: "overwrite" in their WatchQueryOptions.
  : (
    networkStatus === NetworkStatus.refetch &&
    normalized.refetchWritePolicy !== "merge"
  ) ?
    CacheWriteBehavior.OVERWRITE
  : CacheWriteBehavior.MERGE;
```

| Behaviour | Effect on the cache |
| --- | --- |
| `FORBID` | no `diff`, no `write` — `markQueryResult` returns the raw network result |
| `OVERWRITE` | `writeQuery({ overwrite: true })` → `StoreWriter` sets `overwrite` in `WriteContext`, which suppresses `warnAboutDataLoss` **and** makes paginated `merge` functions receive `existing === undefined` |
| `MERGE` | the normal write |

`OVERWRITE` is the mechanism behind `refetchWritePolicy: "overwrite"` (the default for
refetches). Without it, a refetch of `feed(offset: 0)` would append to the existing list via
the user's `merge` function rather than replacing it.

### 8.4 `QueryInfo.markQueryResult` — the write path and the feud breaker

This is the single most important cache interaction in the client. Every network result for
a watched query goes through it.

```mermaid
sequenceDiagram
    autonumber
    participant L as Link result
    participant QI as QueryInfo
    participant C as InMemoryCache
    participant W as StoreWriter
    participant OQ as ObservableQuery watch

    L->>QI: markQueryResult(incoming, opInfo)
    QI->>OQ: resetNotifications() — cancel pending notify
    QI->>C: diff({ returnPartialData: true, optimistic: true })
    C-->>QI: lastDiff
    Note over QI: incremental (@defer) merge uses lastDiff.result as the base
    QI->>C: batch({ update, onWatchUpdated })
    activate C
    Note over C: txCount++ — broadcasts deferred
    alt shouldWrite(result, variables)
        QI->>C: cache.writeQuery({ query, data, variables, overwrite })
        C->>W: writeToStore
        W-->>C: dirty fields
        Note over QI: lastWrite = { result, variables, dmCount }
    else identical to lastWrite
        Note over QI: skip the write — feud breaker
        alt lastDiff.complete
            Note over QI: result.data = lastDiff.result#59; return early
        end
    end
    QI->>C: cache.diff(diffOptions) — read back
    C-->>QI: diff
    alt diff.complete
        Note over QI: result.data = diff.result<br/>(read functions now applied)
    else __DEV__ && written && !hasNext
        Note over QI: warnAboutPartialCacheResult
    end
    Note over C: txCount-- → broadcastWatches()
    C->>QI: onWatchUpdated(watch, diff)
    Note over QI: if watch.watcher === this.observableQuery<br/>watch.lastOwnDiff = diff
    C->>OQ: callback(diff) — dropped by gate 1
    deactivate C
```

Three things deserve emphasis.

**Why a `batch` at all.** The comment says it plainly:

```ts
// Using a transaction here so we have a chance to read the result
// back from the cache before the watch callback fires as a result
// of writeQuery, so we can store the new diff quietly and ignore
// it when we receive it redundantly from the watch callback.
```

The `update` function writes *and then* re-reads, all while `txCount > 0`. Only when the
batch unwinds does the broadcast fire, and by then `onWatchUpdated` has already tagged the
watch with `lastOwnDiff`.

**The read-back replaces the network result.** If the cache can produce a complete result,
`result.data` becomes the *cache's* version, not the server's:

```ts
if (diff.complete) {
  result = { ...result, data: diff.result };
}
```

This is how `read` functions, `merge` functions, and normalization-driven cross-query
consistency reach the caller. It is also why a `read` function that drops a field triggers
`warnAboutPartialCacheResult` — the client wrote data it then could not read back, so it
falls back to the raw network result and loses all `read`-function output.

**The feud breaker.** `shouldWrite` guards against two queries repeatedly clobbering each
other's version of the same entity:

```ts
private shouldWrite(result, variables) {
  const { lastWrite } = this;
  return !(
    lastWrite &&
    // If cache.evict has been called since the last time we wrote this
    // data into the cache, there's a chance writing this result into
    // the cache will repair what was evicted.
    lastWrite.dmCount === destructiveMethodCounts.get(this.cache) &&
    equal(variables, lastWrite.variables) &&
    equal(result.data, lastWrite.result.data) &&
    result.extensions?.[streamInfoSymbol] ===
      lastWrite.result.extensions?.[streamInfoSymbol]
  );
}
```

`destructiveMethodCounts` is maintained by monkey-patching the cache — the one place in
Apollo Client where the cache's own methods are wrapped from outside:

```ts
function wrapDestructiveCacheMethod(cache: ApolloCache, methodName: "evict" | "modify" | "reset") {
  const original = cache[methodName];
  if (typeof original === "function") {
    cache[methodName] = function () {
      destructiveMethodCounts.set(cache, (destructiveMethodCounts.get(cache)! + 1) % 1e15);
      return original.apply(this, arguments);
    };
  }
}
```

The counter is installed once per cache (guarded by `destructiveMethodCounts.has(cache)`)
by the first `QueryInfo` constructed for that cache. Any `evict`/`modify`/`reset` bumps it,
which forces the next identical network result to be written again — because eviction may
have removed exactly the data this result would restore.

> **Re-implementation note.** A drop-in `InMemoryCache` replacement must keep `evict`,
> `modify` and `reset` as **writable own-or-prototype properties assignable on the
> instance**. If they were defined as non-writable, or as class fields captured by internal
> closures that bypass the patched property, the feud breaker silently stops seeing
> destructive operations and stale results stop being repaired.

### 8.5 Mutations — optimistic layer, final write, root-field scrub

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Optimistic: optimisticResponse provided
    [*] --> InFlight: no optimisticResponse

    Optimistic: markMutationOptimistic
    Optimistic: recordOptimisticTransaction(tx, queryInfo.id)
    Optimistic: → Layer(id = queryInfo.id) on optimisticData
    Optimistic: writes ROOT_MUTATION + runs update() in the layer
    Optimistic --> InFlight: link request starts

    InFlight --> Success: link emits result
    InFlight --> Failure: link errors

    Success: markMutationResult
    Success: refetchQueries({ optimistic:false, removeOptimistic: id })
    Success: → cache.batch removes the layer AND writes root, one broadcast
    Success --> Scrubbed

    Scrubbed: cache.modify({ id: "ROOT_MUTATION", fields → DELETE })
    Scrubbed: keeps only __typename
    Scrubbed --> [*]

    Failure: cache.removeOptimistic(queryInfo.id)
    Failure: broadcastQueries()
    Failure --> [*]
```

The optimistic entry point is tiny — it simply replays the *whole* result-marking path
inside a recorded transaction:

```ts
this.cache.recordOptimisticTransaction((cache) => {
  try {
    this.markMutationResult({ data }, mutation, cache as TCache);
  } catch (error) {
    invariant.error(error);
  }
}, this.id);
```

Because `markMutationResult` takes the cache as a parameter (defaulting to `this.cache`),
the optimistic run writes to the **layer** handed to the transaction, while the real run
writes to the root. Same code, two targets — this is why `update` functions must be pure
enough to run twice.

The layer id is `queryInfo.id` (a per-`QueryManager` counter stringified), and the same
string is passed as `removeOptimistic` to the final `refetchQueries`, so removal and the
authoritative write collapse into a single `batch` and therefore a single broadcast (§6.4).

Three cache-visible details:

- **`ROOT_MUTATION` is written and then scrubbed.** The write is needed so `update`
  functions can `cache.diff({ id: "ROOT_MUTATION" })` and see `read`-function output. The
  scrub is a `modify` rather than an `evict` because it must be rollback-safe:

  ```ts
  // TODO Do this with cache.evict({ id: 'ROOT_MUTATION' }) but make it
  // shallow to allow rolling back optimistic evictions.
  cache.modify({
    id: "ROOT_MUTATION",
    fields(value, { fieldName, DELETE }) {
      return fieldName === "__typename" ? value : DELETE;
    },
  });
  ```

  `keepRootFields: true` skips it. Entities referenced from `ROOT_MUTATION` survive the
  scrub — only the root's own fields go, and the entities are reachable from `ROOT_QUERY`
  or retained elsewhere (or become garbage at the next `gc()`).
- **`updateQueries` reads through `getCacheDiff({ optimistic: false })`** and only runs the
  reducer when `complete` — an incomplete query is skipped silently.
- **Nothing is scrubbed while `hasNext`** (`@defer` still streaming), so partial mutation
  payloads accumulate on `ROOT_MUTATION` until the final chunk.

### 8.6 `refetchQueries` — the batch-and-collect protocol

`QueryManager.refetchQueries` is the most elaborate `cache.batch` caller in the codebase,
and the reason `onWatchUpdated`'s return value is meaningful (§6.4).

```mermaid
flowchart TB
    START["refetchQueries({ updateCache, include,<br/>optimistic, removeOptimistic, onQueryUpdated })"]:::api
    INC["include → getObservableQueries(include)<br/>seed includedQueriesByOq with lastDiff<br/><i>skips cache-only and variablesUnknown</i>"]:::read
    BATCH["cache.batch({ update: updateCache,<br/>optimistic: (optimistic &amp;&amp; removeOptimistic) || false,<br/>removeOptimistic, onWatchUpdated })"]:::write
    OWU{"onWatchUpdated(watch, diff, lastDiff)<br/>watch.watcher instanceof ObservableQuery<br/>&amp;&amp; not already handled?"}:::memo
    HAS["onQueryUpdated provided?"]:::memo
    CALL["result = onQueryUpdated(oq, diff, lastDiff)<br/>true → oq.refetch().retain()<br/>false → skip AND suppress broadcast<br/>other → collected into results"]:::write
    DEF["onQueryUpdated !== null &amp;&amp;<br/>fetchPolicy !== 'cache-only'<br/>→ add to includedQueriesByOq"]:::read
    AFTER["for each includedQueriesByOq entry:<br/>onQueryUpdated ?? refetch().retain()"]:::write
    RM["removeOptimistic (again, defensively —<br/>no-op if batch already removed it)"]:::dirty
    OUT["Map&lt;ObservableQuery, result&gt;"]:::store

    START --> INC --> BATCH --> OWU
    OWU -->|yes| HAS
    HAS -->|yes| CALL
    HAS -->|no| DEF
    OWU -->|no| BATCH
    CALL --> AFTER
    DEF --> AFTER
    AFTER --> RM --> OUT

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

The `optimistic` translation is the subtle part:

```ts
optimistic: (optimistic && removeOptimistic) || false,
```

`refetchQueries` accepts only `true`/`false`, but `cache.batch` accepts `false | true |
string`. `true` is translated into the **string** form, which (§6.4) creates a temporary
layer, runs `updateCache` inside it, and — paired with `removeOptimistic` — discards it
immediately. That gives "run this update, notify everyone about its effects, then roll it
back" in a single broadcast. The comment spells out the deliberate non-support:

```ts
// In other words, we are deliberately not supporting the use case of
// writing to an *existing* optimistic layer (using the refetchQueries
// updateCache function), since that would potentially interfere with
// other optimistic updates in progress.
```

`onQueryUpdated` returning `false` is the only way application code can **suppress a cache
broadcast to a specific watcher** — it propagates back into `broadcastWatches`'s
`onWatchUpdated` return check (§6.4).

### 8.7 Broadcast → notify → reobserve

There are two independent notification systems, and confusing them is a common source of
bugs. The cache's broadcast is *per-watch and synchronous*; `QueryManager.broadcastQueries`
is *global and imperative*.

```mermaid
flowchart TB
    subgraph cacheside["Cache-driven (per-watch, synchronous)"]
        BW["cache.broadcastWatches()"]:::memo
        MBW["maybeBroadcastWatch(watch)<br/><i>memoized; equality gate</i>"]:::memo
        CB["watch.callback(diff)"]:::memo
        SN["oq.scheduleNotify()<br/><i>dirty = true; setTimeout(…, 0)</i>"]:::write
    end

    subgraph clientside["Client-driven (global, imperative)"]
        BQ["queryManager.broadcastQueries()"]:::ext
        NF["oq.notify() for every obsQuery"]:::ext
    end

    NOTIFY["ObservableQuery.notify(scheduled)"]:::api
    GATE{"dirty AND<br/>(cache-only || cache-and-network<br/>|| no active operations)?"}:::dirty
    DROP["drop"]:::dirty
    OPTCHK{"equal(optimistic diff,<br/>non-optimistic diff)?"}:::dirty
    RCF["reobserveCacheFirst()<br/><i>may hit the network</i>"]:::write
    PUSH["input.next({ source: 'cache' })<br/><i>never hits the network</i>"]:::read

    BW --> MBW --> CB --> SN --> NOTIFY
    BQ --> NF --> NOTIFY
    NOTIFY --> GATE
    GATE -->|no| DROP
    GATE -->|yes| OPTCHK
    OPTCHK -->|yes: not optimistic| RCF
    OPTCHK -->|no: optimistic in play| PUSH

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

`broadcastQueries` is deliberately dumb:

```ts
public broadcastQueries() {
  if (this.onBroadcast) this.onBroadcast();
  this.obsQueries.forEach((observableQuery) => observableQuery.notify());
}
```

It is called after mutations, after `refetchObservableQueries`, and after subscription
results — situations where client state (not just cache state) changed. `notify(false)`
short-circuits for `@client @export`/forced-resolver queries so those only ever wake up via
the cache's own deferred `scheduleNotify` path.

The **optimistic check inside `notify`** is a second, independent use of the cache:

```ts
const diff = this.getCacheDiff();
if (equal(diff.result, this.getCacheDiff({ optimistic: false }).result)) {
  this.reobserveCacheFirst();
} else {
  this.input.next({ /* deliver the optimistic data, no network */ });
}
```

Two full `diff` calls — one against `optimisticData`, one against `data` — run on every
notification. When they agree, the query is free to reobserve (possibly refetching); when
they differ, an optimistic layer is in play and the client refuses to start a network
request in the middle of it. §7.2's `fromOptimisticTransaction` flag exists for the
`broadcastWatch` path; this comparison is the equivalent for the `notify` path, and the
comment says so: *"`fromOptimisticTransaction` is not available through the `cache.diff`
code path, so we need to check it this way."*

> **Performance note.** Both diffs hit `StoreReader`'s memo once warm, but they hit
> *different* entries: `optimisticData` is the `Stump`, which owns its own `CacheGroup` and
> therefore its own `keyMaker` `Trie`, **even when no optimistic layer exists** (§2.1). So
> every watched query maintains two complete sets of memo entries, and the first optimistic
> read after a write is a full cold read regardless of how warm the root read is. The
> companion performance document measures this.

### 8.8 Local state and `@client` fields

`LocalState` is a cache *consultant*, not a cache writer. It touches the cache in exactly
two ways:

```ts
cache.fragmentMatches(selection, rootValue.__typename)   // inline fragments
cache.fragmentMatches(fragment, typename ?? "")          // named fragment spreads
```

and, from `QueryManager`, via `resolvesClientField` (§7.16), which decides whether a
`@client` field is the *cache's* responsibility (a `read` function in `typePolicies`) or
the *resolver's*. If neither provides it, local state warns and writes `null`.

The `hasForcedResolvers` path is the interesting one for cache semantics. When a query has
`@client(always: true)` fields, `fetchQueryByPolicy` runs local resolvers **over the cache
diff result**, so the emitted data is `cache diff → resolver overlay`, and — per §8.2 gate 0
— the watch's equality gate is disabled because the overlay can change while the diff does
not.

### 8.9 Data masking

Masking sits *after* the cache and consumes two metadata methods:

| Call | Purpose |
| --- | --- |
| `cache.fragmentMatches(inlineFragment, data.__typename)` | decide whether an inline fragment's fields belong to this object's masked view |
| `cache.lookupFragment(fragmentName)` | resolve a spread whose definition lives only in the fragment registry |

This is why §7.16 flags `fragmentMatches` as load-bearing: the base-class default returns
`true` with a warning, which makes masking permissive (nothing gets masked behind an
interface condition) rather than incorrect-but-silent.

`QueryManager` also injects `@nonreactive` onto every non-`@unmask` fragment spread when
building `nonReactiveQuery` (`addNonReactiveToNamedFragments`), so that a masked fragment's
fields do not wake up a parent query — the cache honours that directive in
`StoreReader`/`StoreWriter` field flattening (Part 4.3).

### 8.10 `resetStore` and `clearStore`

```ts
public clearStore(options: Cache.ResetOptions = { discardWatches: true }): Promise<void> {
  this.cancelPendingFetches(
    newInvariantError("Store reset while query was in flight (not completed in link chain)")
  );
  this.obsQueries.forEach((observableQuery) => { observableQuery.reset(); });
  if (this.mutationStore) { this.mutationStore = {}; }
  return this.cache.reset(options);
}
```

The ordering matters and maps directly onto §7.13:

1. **Cancel in-flight fetches first.** Their results depend on data that is about to
   disappear; writing them back afterwards would resurrect a partial store.
2. **Reset the observable queries** so they do not deliver stale results.
3. **Then** reset the cache. `discardWatches: true` (the `clearStore` default) drops every
   watch and skips the broadcast entirely; `client.resetStore()` uses
   `discardWatches: false` and then calls `refetchObservableQueries()`.

### 8.11 Memory internals — the cache's own telemetry

In development, `client.getMemoryInternals()` reaches into the cache's private memo state.
This doubles as an authoritative list of every memoized function the cache owns:

```ts
function _getInMemoryCacheMemoryInternals(this: InMemoryCache) {
  return {
    ..._getApolloCacheMemoryInternals.apply(this as any),
    addTypenameDocumentTransform: transformInfo(this["addTypenameTransform"]),
    inMemoryCache: {
      executeSelectionSet: getWrapperInformation(this["storeReader"]["executeSelectionSet"]),
      executeSubSelectedArray: getWrapperInformation(this["storeReader"]["executeSubSelectedArray"]),
      maybeBroadcastWatch: getWrapperInformation(this["maybeBroadcastWatch"]),
    },
    fragmentRegistry: {
      findFragmentSpreads: getWrapperInformation(fragments?.findFragmentSpreads),
      lookup: getWrapperInformation(fragments?.lookup),
      transform: getWrapperInformation(fragments?.transform),
    },
  };
}
```

| Memo | Configuration key | Default limit |
| --- | --- | --- |
| `StoreReader.executeSelectionSet` | `inMemoryCache.executeSelectionSet` | 50 000 |
| `StoreReader.executeSubSelectedArray` | `inMemoryCache.executeSubSelectedArray` | 10 000 |
| `InMemoryCache.maybeBroadcastWatch` | `inMemoryCache.maybeBroadcastWatch` | 5 000 |
| `ApolloCache.getFragmentDoc` | `cache.fragmentQueryDocuments` | 1 000 |
| `canonicalStringify` | `canonicalStringify` | 1 000 |
| `FragmentRegistry.lookup` / `.transform` / `.findFragmentSpreads` | `fragmentRegistry.*` | 1 000 / 2 000 / 4 000 |

All are overridable through `import { cacheSizes } from "@apollo/client/utilities"`. Every
one is a *bounded LRU*, so exceeding a limit degrades to recomputation, never to incorrect
results — the correctness of the cache never depends on a memo entry surviving.

---

## Part 9 — Invariants and a re-implementation checklist

This part is the specification distilled. If a re-implementation satisfies every invariant
here and passes `docs/probes/cache-behavior-probe.mjs`, it is behaviourally compatible with
`InMemoryCache` for the surface Apollo Client itself depends on.

### 9.1 The invariants

Each invariant names the part that derives it and the failure mode of violating it.

#### Storage

| # | Invariant | Derived in | Violation shows up as |
| --- | --- | --- | --- |
| S1 | The store is a **flat** `Record<string, StoreObject>`; nesting exists only inside non-normalizable values. | 2.0 | unbounded duplication; cross-query updates stop propagating |
| S2 | Every normalizable object is replaced by `{ __ref: id }` at its parent's field. Reference identity is the *string*, not the object. | 2.0, 4.5 | `===` comparisons on `Reference` objects silently fail |
| S3 | A field's storage key is `getStoreFieldName(typename, fieldName, args, directives, keyArgs)`, not the field's response name. | 3.3 | two argument sets collide; aliases produce phantom fields |
| S4 | `ROOT_QUERY`, `ROOT_MUTATION`, `ROOT_SUBSCRIPTION` are ordinary entries distinguished only by being implicitly retained. | 2.9 | roots get garbage-collected |
| S5 | `extract()` output round-trips through `restore()` exactly, including `__META.extraRootIds` (sorted). | 7.11, 7.12 | SSR hydration loses `retain` state |
| S6 | Writing a field to the value it already holds (`===` or deep-equal per `storeObjectReconciler`) must **not** dirty it. | 2.6 | broadcast storms; infinite render loops |

#### Layers

| # | Invariant | Derived in | Violation shows up as |
| --- | --- | --- | --- |
| L1 | Layers form a singly-linked parent chain; lookup walks child→parent and stops at the first entry that has the `dataId`. | 2.1, 2.2 | optimistic data leaks into non-optimistic reads |
| L2 | `optimisticData` is **always** the `Stump`, never the `Root`, even with zero active layers. Optimistic and non-optimistic reads therefore never share memo entries. | 2.1 | optimistic dependencies pollute the root group |
| L3 | The `Stump` is created in `init()` and is **never removable** (`Stump.removeLayer` returns `this`), so optimistic reads always have a stable `CacheGroup`. | 2.1 | optimistic dependencies get dropped when the last layer pops |
| L4 | Removing a layer **replays** every surviving layer above it, in order, and dirties the union of fields that differ. | 2.10 | rollback leaves stale optimistic values visible |
| L5 | The optimistic `CacheGroup` has the root group as its `parent`, so `depend`/`dirty` propagate root→optimistic but not the reverse. | 2.4 | root reads observe optimistic invalidations, or optimistic reads miss root writes |

#### Dependency tracking and reactivity

| # | Invariant | Derived in | Violation shows up as |
| --- | --- | --- | --- |
| D1 | Every field *read* registers a dependency on `(dataId, storeFieldName)` in the reading group. | 2.4, 5.7 | reads go stale after a write |
| D2 | Every field *write that changed something* dirties `(dataId, storeFieldName)` in the writing group **and its parent groups**. | 2.4, 2.6 | optimistic layer writes do not invalidate root readers |
| D3 | Deleting an entity dirties `(dataId, "__exists")` in addition to each field. | 2.8 | dangling-reference reads keep returning cached results |
| D4 | `broadcastWatches` is a no-op while `txCount > 0`; the count is decremented in a `finally`. | 6.3, 6.4 | a throwing `update` function permanently silences the cache |
| D5 | A watch callback fires only when the new diff is **not** `equal` to `watch.lastDiff` — unless `lastDiff` was cleared. | 6.2 | either missed updates or infinite loops, depending on direction |
| D6 | `watch({ immediate: true })` fires the callback synchronously during `watch()`, before returning the unsubscribe function. | 6.1, 7.6 | first render misses data |
| D7 | `onWatchUpdated` returning `false` suppresses that watch's callback for this broadcast only. | 6.4, 8.6 | `refetchQueries`' skip semantics break |

#### Reads

| # | Invariant | Derived in | Violation shows up as |
| --- | --- | --- | --- |
| R1 | Reads are memoized on `(selectionSet, parentObjectOrReference, variables-as-canonical-string, context)` and the memo is invalidated purely through the dependency graph. | 5.1 | quadratic re-reads, or stale reads |
| R2 | Equal inputs must produce `===`-identical output subtrees. Structure sharing is a **contract**, not an optimization. | 5.6 | React re-renders on every broadcast |
| R3 | Results are deeply frozen under `__DEV__`. | 1.7, 5.6 | accidental mutation corrupts the store |
| R4 | A dangling `Reference` inside a **list** is filtered out and the read stays `complete`; a dangling reference in a **singular** field makes the read incomplete with a `Dangling reference` `MissingFieldError`. | 5.4 | either spurious incompleteness or silently-missing list items |
| R5 | `returnPartialData: false` collapses an incomplete read to `null`; `diff` always returns the partial tree plus `missing`. | 5.2, 7.1 | `read` and `diff` diverge |
| R6 | `@nonreactive` fields are read but **not** depended upon by the enclosing watch. | 4.3 | over-broadcasting |

#### Writes

| # | Invariant | Derived in | Violation shows up as |
| --- | --- | --- | --- |
| W1 | The write is two-phase: `processSelectionSet` stages `incomingById` without touching the store, then a single effectful merge applies it. | 4.1 | a throwing `merge` function leaves the store half-written |
| W2 | Every entity in one write is merged **once**, no matter how many times it appears in the payload. | 4.1, 4.7 | O(occurrences) merges; `merge` functions run repeatedly |
| W3 | `context.written` breaks cycles by `(dataId, selectionSet)`; the `isFresh` check short-circuits re-processing. | 4.7 | infinite recursion on cyclic payloads |
| W4 | User `merge` functions run during `applyMerges`, after normalization, with `existing` read through the same store the write targets. | 4.6 | pagination helpers see references they cannot resolve |
| W5 | `overwrite: true` suppresses `warnAboutDataLoss` and passes `existing: undefined` to merge functions. | 8.3 | refetches append instead of replacing |
| W6 | Writing to a `Layer` writes only to that layer; parent layers are never mutated. | 2.1 | optimistic writes become permanent |

#### Policies

| # | Invariant | Derived in | Violation shows up as |
| --- | --- | --- | --- |
| P1 | `identify` returns `[id, keyObject?]`; a `keyFields` function may return a falsy value to mean "not normalizable". | 3.2 | objects that should stay embedded get IDs |
| P2 | `keyFields` order is the **specifier's** order in the resulting id string; nested object values are key-sorted by `extractKeyPath`'s normalizer. | 3.2 | ids differ between writes of the same entity |
| P3 | `keyArgs`/`keyFields` are resolved through the type-policy inheritance chain (supertypes contribute, subtypes win). | 3.1 | interface-level policies are ignored |
| P4 | `read` functions run inside `cacheSlot`, so reactive variables read there register a dependency. | 3.4, 6.6 | `makeVar` updates do not propagate |
| P5 | `fragmentMatches` uses `possibleTypes` and falls back to fuzzy subtype matching for unknown types, warning once. | 3.6 | interface fragments silently never match |

### 9.2 Build order for a re-implementation

The dependency graph is strict — each stage is testable in isolation with the probe subset
named beside it.

```mermaid
flowchart TB
    S1["<b>1. Primitives</b><br/>canonicalStringify · DeepMerger<br/>deep equality · maybeDeepFreeze"]:::store
    S2["<b>2. Dependency engine</b><br/>Entry graph · dep() · wrap()<br/>bounded LRU + Trie key maker"]:::memo
    S3["<b>3. EntityStore.Root</b><br/>flat map · merge · lookup<br/>CacheGroup depend/dirty"]:::store
    S4["<b>4. Policies</b><br/>identify · getStoreFieldName<br/>readField · fragmentMatches"]:::api
    S5["<b>5. StoreWriter</b><br/>two-phase write · MergeTree<br/>merge functions"]:::write
    S6["<b>6. StoreReader</b><br/>memoized executeSelectionSet<br/>missing tree · canRead filtering"]:::read
    S7["<b>7. Watches + broadcast</b><br/>watch · maybeBroadcastWatch<br/>txCount batching"]:::memo
    S8["<b>8. Layers</b><br/>Stump · Layer · removeLayer replay<br/>batch optimistic modes"]:::dirty
    S9["<b>9. Lifecycle</b><br/>modify · evict · gc<br/>retain/release · extract/restore"]:::dirty
    S10["<b>10. Client integration</b><br/>transformDocument idempotence<br/>writable evict/modify/reset<br/>watcher/lastOwnDiff passthrough"]:::ext

    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8 --> S9 --> S10

    S1 -.->|"probe: immutability,<br/>canonical keys"| S1
    S3 -.->|"probe: normalization,<br/>identity"| S3
    S5 -.->|"probe: merge functions,<br/>field keys"| S5
    S6 -.->|"probe: result caching,<br/>dangling refs"| S6
    S7 -.->|"probe: broadcast gating"| S7
    S8 -.->|"probe: optimistic layers"| S8
    S9 -.->|"probe: modify, evict, gc,<br/>reset/restore"| S9

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

Stage 2 is the one most often underestimated. The dependency engine is not an optimization
layer bolted on top of a working cache — invariants D1–D3 and R1–R2 mean **the memo graph
is the cache's change-detection mechanism**. A correct-but-unmemoized reader would still
break `ObservableQuery`, because R2 (`===`-stable subtrees) is what stops React from
re-rendering on every unrelated write.

### 9.3 Cross-boundary requirements

A replacement cache that only satisfies Parts 2–7 will still misbehave inside Apollo Client
unless it also honours these:

| Requirement | Why | Part |
| --- | --- | --- |
| `transformDocument` must be idempotent **and** return `===`-stable documents | it is applied twice around user transforms; document identity keys every downstream memo | 8.1 |
| `evict`, `modify` and `reset` must be instance-assignable | `QueryInfo` monkey-patches them to count destructive operations; the feud breaker depends on it | 8.4 |
| `Cache.WatchOptions` must be passed through to `onWatchUpdated` **by reference**, preserving unknown extension fields | `watcher` and `lastOwnDiff` are set by client code on the same object | 8.2, 8.6 |
| The `diff` object handed to `onWatchUpdated` must be the **same object** later handed to `watch.callback` | gate 1 compares by reference | 8.2 |
| `batch` must call `onWatchUpdated` for every dirtied watch and respect a `false` return | `refetchQueries`' skip semantics | 8.6 |
| `diff` results must carry `fromOptimisticTransaction` when broadcast from a string-id optimistic transaction | `ObservableQuery` refuses network requests mid-optimistic-update | 7.2, 8.7 |
| `assumeImmutableResults` must be `true` and honestly so | `ApolloClient` propagates it as a capability declaration | 7.18 |
| `getMemoryInternals` is optional | absent → the dev tool reports fewer sections, nothing breaks | 8.11 |

### 9.4 The minimum viable surface

For a cache that only needs to work with `ApolloClient` (not with third-party code reaching
into `cache.policies`), implementing these eleven methods is sufficient; the remaining
`ApolloCache` surface is inherited or optional.

```mermaid
flowchart LR
    subgraph must["Must implement — client will call these"]
        M1["read · diff"]:::read
        M2["write"]:::write
        M3["watch"]:::memo
        M4["batch / performTransaction"]:::write
        M5["removeOptimistic"]:::dirty
        M6["evict · modify · reset"]:::dirty
        M7["identify"]:::api
        M8["transformDocument"]:::api
        M9["fragmentMatches · lookupFragment"]:::api
        M10["extract · restore"]:::store
        M11["gc · retain · release"]:::dirty
    end

    subgraph free["Free once the above are correct"]
        F1["readQuery · readFragment<br/>writeQuery · writeFragment<br/>updateQuery · updateFragment<br/>watchFragment · recordOptimisticTransaction"]:::ext
    end

    must --> free

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

`resolvesClientField` is genuinely optional (it degrades local-state handling of `@client`
fields backed by cache `read` functions), and `gc`/`retain`/`release` are never called by
the client itself — only by application code — but omitting them turns the cache into an
unbounded leak for any application that evicts.

### 9.5 Where to look when something is wrong

| Symptom | First suspect | Part |
| --- | --- | --- |
| Component re-renders on every unrelated write | R2 structure sharing broken, or `watch.lastDiff` cleared | 5.6, 6.2 |
| Update written but component never re-renders | dependency not registered (D1), or `txCount` leak (D4) | 2.4, 6.3 |
| "Cache data may be lost" warning | field returned a non-normalized object where one was previously stored | 4.8 |
| Read comes back partial after a successful write | a `read`/`merge` function dropped a field — see `warnAboutPartialCacheResult` | 8.4 |
| Optimistic update never rolls back | layer replay (L4) or `removeOptimistic` id mismatch | 2.10, 8.5 |
| Two queries fight, network request loop | feud breaker disabled — check that `evict`/`modify`/`reset` are patchable | 8.4 |
| List grows on refetch instead of replacing | `refetchWritePolicy` / `overwrite` not threaded to the writer | 8.3 |
| Entity duplicated under two ids | `keyFields` ordering (P2) or a missing `__typename` | 3.2 |
| `makeVar` update ignored | `read` function not invoked inside `cacheSlot` (P4) | 3.4, 6.6 |
| Data disappears after `gc()` | missing `retain`, or `__META.extraRootIds` lost on restore (S5) | 2.9, 7.12 |

