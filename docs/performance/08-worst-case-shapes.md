# Part 8 — Worst-case shapes and a stress corpus

[Documentation](../README.md) › [Performance guide](README.md) · [← Part 7](07-structural-stress.md) · [Part 9 →](09-optimization-playbook.md)

## 8.1 The four adversarial payloads

```mermaid
flowchart TB
    subgraph s1["Shape 1 — the deep chain"]
        A1["root → child → child → ... (D in the hundreds)<br/>every level normalized"]:::dirty
        A2["<b>stresses:</b> invalidation blast radius (O(D²) re-read),<br/>path allocation (O(F·D²) write), recursion depth"]:::dirty
        A1 --> A2
    end

    subgraph s2["Shape 2 — the fat blob"]
        B1["one field holding a 1 MB untyped value,<br/>rewritten every poll"]:::dirty
        B2["<b>stresses:</b> storeObjectReconciler equal();<br/>in development, cloneDeep on write<br/>and deepFreeze on read"]:::dirty
        B1 --> B2
    end

    subgraph s3["Shape 3 — the ragged matrix"]
        C1["groups: [ rows: [ cells: [...] ] ]<br/>three levels of arrays, entities at the leaves,<br/>total entities near the 50 000 memo limit"]:::dirty
        C2["<b>stresses:</b> array-instance memo keys,<br/>filter + map allocation per level,<br/>and the LRU cliff (§4.3)"]:::dirty
        C1 --> C2
    end

    subgraph s4["Shape 4 — the document explosion"]
        D1["N components each building their own<br/>gql document at render time"]:::dirty
        D2["<b>stresses:</b> memo key fragmentation,<br/>LRU eviction, broadcasts that recompute<br/>large parts of every read"]:::dirty
        D1 --> D2
    end

    A2 ~~~ B1
    B2 ~~~ C1
    C2 ~~~ D1

    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

## 8.2 A stress-test corpus for a re-implementation

Any `InMemoryCache` replacement should be benchmarked against these axes, in this order,
because each isolates one hot path:

| Axis | Vary | Holds constant | Detects a regression in | In the probe |
| --- | --- | --- | --- | --- |
| breadth | `N` = 100 → 20 000 | `F`, `D` = 2 | traversal, allocation per entity | yes (sections 1–3) |
| depth | `D` = 4 → 512 | `F` | invalidation propagation, path allocation | yes (section 4) |
| fields | `F` = 2 → 64 | `E`, `D` | per-field allocation, `mergeDeepArray` | **no** |
| blob size | `B`: embedded bytes 1 KB → 1 MB | everything else | `equal()` cost | **no** |
| array nesting | 1 → 3 levels | total elements | `executeSubSelectedArray` keying | partly: 2 levels (section 5) |
| arguments | `A`: 0 → 24 args, nested 1 → 128 levels, on a root field *and* on a per-item field | result size | `canonicalStringify` | partly: root field only (section 10) |
| watchers | `W` = 1 → 200, shared vs. distinct docs | store size | broadcast fan-out, memo sharing | yes (section 6) |
| layers | `L` = 1 → 64, LIFO vs. FIFO removal | store size | layer chain walk, replay | yes (section 7) |
| store size | `S` = 1 000 → 100 000 | operation | `gc`, `extract` | partly: 1 000 → 20 000 (section 12) |
| dirty fraction | 0% → 100% of entities changed | `E` | dirty propagation, re-read cost | **no** (only a single changed field) |
| memo capacity | entities either side of the LRU limit | query shape | eviction policy, cliff behaviour | yes (section 9) |
| optimistic vs. root reads | same query, both `optimistic` values | store size | memo-set separation ([§4.2](04-dependency-graph-and-broadcast.md#42-optimistic-reads-maintain-a-second-set-of-memo-entries)) | yes (section 8) |

The probe covers nine of these axes fully or partly (last column); the fields, blob-size
and dirty-fraction axes still need benchmarks of their own. The two measurements that most
often reveal a broken re-implementation are **"read after 1 dirty"** (proves the memo graph
is wired correctly) and **"write identical"** (proves that an unchanged write dirties
nothing; if it does not, every identical write recomputes every affected watch).

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Part 7 — Structural properties that stress the hot paths](07-structural-stress.md) | [Performance guide](README.md) | [Part 9 — Optimization playbook](09-optimization-playbook.md) |
