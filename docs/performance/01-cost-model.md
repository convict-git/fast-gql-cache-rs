# Part 1 — The cost model in one page

[Documentation](../README.md) › [Performance guide](README.md) · [← Performance guide](README.md) · [Part 2 →](02-write-path.md)

## 1.1 The four costs that matter

Almost all `InMemoryCache` time is one of four things. Everything else is noise.

```mermaid
flowchart TB
    subgraph T["The four dominant costs"]
        direction TB
        C1["<b>1. Traversal</b><br/>walking the selection set x result tree<br/><i>write: processSelectionSet</i><br/><i>read: execSelectionSetImpl</i>"]:::write
        C2["<b>2. Deep equality</b><br/>@wry/equality on every field whose<br/>reference changed<br/><i>storeObjectReconciler, broadcast gate</i>"]:::dirty
        C3["<b>3. Allocation</b><br/>one object per field, one Map/Set/Trie<br/>per entity, one path array per field<br/><i>then GC pressure</i>"]:::store
        C4["<b>4. Memo bookkeeping</b><br/>Trie key lookup + dep registration<br/>per field read, dirty propagation<br/>per field written"]:::memo
    end

    C1 --> OUT["Wall-clock time"]:::api
    C2 --> OUT
    C3 --> OUT
    C4 --> OUT

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

The single most important structural fact:

> **Reads are memoized per subtree; writes are not memoized.**
>
> A warm read of a 5 000-entity list costs microseconds. A write of the same
> data — even a byte-for-byte identical one — costs tens of milliseconds. For a fresh
> payload, such as a network response, there is no "nothing changed" fast path, because the
> writer cannot know nothing changed until it has normalized the payload and compared every
> field. (The one shortcut, `isFresh`, applies only to entity objects that are the very
> objects the reader handed out — the `readQuery` → edit → `writeQuery` pattern — and
> even then it skips the merge into the store, not the traversal:
> [architecture §4.7](../architecture/04-store-writer.md#47-the-duplicate-guard-and-the-isfresh-short-circuit).)

## 1.2 Headline complexity table

| Operation | Complexity | Memoized? | Dominant term |
| --- | --- | --- | --- |
| `write` (entities are new) | `O(E · F)` | no | traversal + `identify` + allocation + dirtying every field |
| `write` (overwrite, identical payload) | `O(E · F)` + `O(bytes compared)` | no | `storeObjectReconciler` → `equal()` |
| `read` / `diff` (cold) | `O(E · F)` | — | traversal + `mergeDeepArray` |
| `read` / `diff` (warm, nothing dirty) | `O(1)` amortized | **yes** | one Trie lookup |
| `read` after `k` dirty entities | `O(k · F + ancestors)`; a list ancestor of length `N` costs `O(N)` | partial | recompute the invalidated entries and every ancestor |
| `broadcast` (nothing relevant dirty) | `O(W)` cheap checks | yes | `maybeBroadcastWatch` memo hit |
| `broadcast` (relevant write) | `O(W · affected subtree)` | partial | one re-read per distinct document |
| `modify` / `evict` (single id) | `O(F)`, `O(L · F)` with `L` layers | — | dirty propagation |
| `gc()` | `O(S · F)` **always** | no | mark-and-sweep over the whole store |
| `extract()` | `O(S)` | no | `toObject` (a shallow copy of the entity map) + `__META` |
| `restore()` | `O(S · F)` | no | one merge per entity, no normalization; every field is walked for dirtying, and the snapshot objects are adopted by reference |
| `removeOptimistic` (top layer) | `O(layer size)` | no | dirty the layer's fields |
| `removeOptimistic` (bottom of `L`) | `O(L · layer size)` | no | **replay every layer above** |

## 1.3 Measured: the shape of the curves

One list of `n` normalized entities, six scalar fields each, measured end to end:

| `n` | write cold | write identical payload | read cold | read warm | read after 1 dirty field |
| --- | --- | --- | --- | --- | --- |
| 100 | 1.50 ms | 796 µs | 1.56 ms | **2.9 µs** | 187 µs |
| 1 000 | 8.79 ms | 7.75 ms | 15.70 ms | **2.5 µs** | 1.66 ms |
| 5 000 | 44.00 ms | 39.65 ms | 78.63 ms | **2.7 µs** | 8.87 ms |
| 20 000 | 182.46 ms | 164.33 ms | 333.45 ms | **2.5 µs** | 45.08 ms |

Three readings, in descending order of importance:

1. **The warm-read column is flat.** 2.5–2.9 µs whether the list holds 100 entities or
   20 000. That is the memo graph doing its job, and it is why the read path rarely shows
   up in a profile of a healthy application.
2. **Writing a byte-identical payload costs 90 % of a cold write** — 164 ms against 182 ms
   at `n = 20 000`. Polling an unchanged response is almost as expensive as receiving a new
   one.
3. **One dirty field costs 7–9.5× less than a cold read but still scales linearly.** 45 ms
   to re-read a 20 000-entity list after a single field changed. Memoization improves the
   constant here, not the exponent ([§3.3](03-read-path.md#33-invalidation-blast-radius--the-single-most-important-read-path-concept)).

> **Reading the `scale` column** in the tables that follow: it is the growth factor
> between two adjacent rows divided by their size ratio. `1.00n` is linear at any step. A
> constant cost shows up as `1/ratio` (`0.10n` for a 10× step, `0.25n` for 4×, `0.50n` for
> 2×), and a quadratic cost as the ratio itself (`10n` for a 10× step, `4n` for 4×, `2n`
> for 2×), so always read it together with the step size. It is the number to trust:
> absolute timings vary by machine, growth rates do not. (The steps used by the probe
> are 10×, 5× and 4× for most tables, and 2× for the last depth row.)

## 1.4 The one diagram to remember

```mermaid
flowchart TB
    subgraph writeside["WRITE — always full cost"]
        direction TB
        WA["payload arrives"]:::write
        WB["traverse selection set x result<br/><i>O(E·F)</i>"]:::write
        WC["identify() every object<br/><i>O(E) + keyFields extraction</i>"]:::write
        WD["deep-equality vs. existing<br/><i>O(bytes changed + bytes compared)</i>"]:::dirty
        WE["dirty each changed field<br/><i>O(changed fields)</i>"]:::dirty
        WA --> WB --> WC --> WD --> WE
    end

    subgraph readside["READ — cost proportional to INVALIDATION, not size"]
        direction TB
        RA["read requested"]:::read
        RB{"memo entry clean?"}:::memo
        RC["return cached tree<br/><i>O(1)</i>"]:::memo
        RD["recompute ONLY dirty subtrees<br/>+ every ANCESTOR of them"]:::read
        RA --> RB
        RB -->|yes| RC
        RB -->|no| RD
    end

    WE -.->|"dirty()"| RB

    NOTE["<b>The asymmetry is the whole story.</b><br/>Writes pay for the payload.<br/>Reads pay for the blast radius of the last write."]:::api

    readside --> NOTE

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Performance guide](README.md) | [Performance guide](README.md) | [Part 2 — The write path](02-write-path.md) |
