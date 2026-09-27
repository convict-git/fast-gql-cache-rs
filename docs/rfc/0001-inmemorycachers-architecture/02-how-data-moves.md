# RFC 0001, Level 2: how data moves

[Documentation home](../../README.md) › [RFC 0001](README.md) · [← Level 1: the idea](README.md) · [Level 3: the design in depth →](03-design-in-depth.md)

## 4. The example application

### 4.1 What the support board does

| Feature | Apollo API the app uses | Cache calls it causes |
| --- | --- | --- |
| the board, polled every 5 s | `useQuery(BOARD, { variables: { status: "OPEN" }, pollInterval: 5000 })` | a `watch`, then per response `batch` → `writeQuery` → `diff`, and a broadcast |
| an "open tickets" badge | `useQuery(OPEN_COUNT)`: `tickets(status: OPEN) { id }` | a second watch over the same list |
| the detail pane of one ticket | `useFragment({ fragment: TICKET_DETAIL, from: ticket })` | `identify`, then `watchFragment`, which is a `watch` |
| reassigning a ticket | `useMutation(ASSIGN, { optimisticResponse })` | `recordOptimisticTransaction` (a layer), then `batch` with `removeOptimistic` |
| a ticket created by this agent | the mutation's `update` function calls `cache.modify` | `modify`, and a nested `writeFragment` |
| the activity log, with "load more" | `fetchMore({ variables: { offset: 20 } })` | `batch` → `writeQuery`, merged by a descriptor |
| forgetting a closed ticket | `cache.evict` and `cache.gc` | `evict`, `gc` |
| server rendering | one cache per request, `extract` on the server, `restore` in the browser | `extract`, `restore`, `[Symbol.dispose]` |

The other operations:

```graphql
query OpenCount { tickets(status: OPEN) { id } }

fragment TicketDetail on Ticket { id title status assignee { id name } meta }

mutation Assign($id: ID!, $userId: ID!) {
  assignTicket(id: $id, userId: $userId) { id assignee { id name } }
}

query Activity($ticketId: ID!, $offset: Int!, $limit: Int!) {
  activity(ticketId: $ticketId, offset: $offset, limit: $limit) { id at text }
}
```

The configuration is the "after" of [§3.3](README.md#33-what-an-application-changes): `tickets` has
no policy, so every argument is part of its store key; `activity` is keyed by `ticketId`
alone and merged with `{ list: "offset" }`; and a `ticket(id)` field is redirected to the
`Ticket` entity when `ROOT_QUERY` does not hold it.

### 4.2 Its traffic through the cache

Every arrow below is a call path in Apollo Client 4.2.11
([Apollo architecture §8.0](../../research/architecture/08-client-pipeline.md#80-the-call-map)). None of them
changes: `InMemoryCacheRs` receives exactly the calls `InMemoryCache` receives.

```mermaid
flowchart LR
    subgraph react["The board's components"]
        direction TB
        BOARD["Board list<br/>useQuery, polling"]:::ext
        BADGE["Open badge<br/>useQuery"]:::ext
        DETAIL["Detail pane<br/>useFragment"]:::ext
        ASSIGN["Reassign button<br/>useMutation"]:::ext
        MORE["Load more<br/>fetchMore"]:::ext
    end

    subgraph ac["Apollo Client (unchanged)"]
        direction TB
        OQ["ObservableQuery<br/>one watch each"]:::ext
        QI["QueryInfo<br/>markQueryResult,<br/>markMutationResult"]:::ext
        QM["QueryManager<br/>mutations, refetchQueries"]:::ext
        CL["ApolloClient<br/>watchFragment"]:::ext
    end

    subgraph api["InMemoryCacheRs: the ApolloCache API"]
        direction TB
        RD["diff, read"]:::read
        WR["write, writeQuery,<br/>writeFragment"]:::write
        WA["watch"]:::memo
        BA["batch, recordOptimistic-<br/>Transaction"]:::write
        MU["modify, evict, gc,<br/>removeOptimistic"]:::dirty
        MI["identify, transformDocument,<br/>extract, restore"]:::api
    end

    BOARD --> OQ
    BADGE --> OQ
    MORE --> OQ
    DETAIL --> CL
    ASSIGN --> QM
    OQ --> WA & RD & BA
    QI --> BA & WR & RD & MU
    QM --> QI
    QM --> BA & MU & MI
    CL --> WA & MI

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

## 5. Walkthroughs: ten flows through one application

Each walkthrough follows one thing the board does, from the Apollo Client call to the
Rust engine and back. It says what `InMemoryCache` does at that point, draws what
`InMemoryCacheRs` does, and ends with what differs. The walkthroughs stay at the level of
"who does what"; the Level 3 section linked at the end of each one has the mechanism.

In the sequence diagrams, participants are boxed by owner: Apollo Client or the
application, the JavaScript side of `InMemoryCacheRs`, and the Rust engine. A message
between the JavaScript box and the Rust box crosses the boundary, and a dashed arrow is a
return value.

### 5.1 Constructing the cache

**In `InMemoryCache`**, the constructor stores the configuration, builds `Policies`, the
`Root` store with its `Stump`, and the reader and writer. Functions are accepted wherever a
policy allows them.

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Application
        participant APP as app module
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant VAL as profile validation
        participant LD as WASM loader
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine instance
    end

    APP->>SH: new InMemoryCacheRs(config)
    SH->>VAL: validate the whole config
    alt a function, dataIdFromObject, a fuzzy possibleTypes entry, resultCaching false
        VAL-->>APP: throw one error naming every offending path
    end
    VAL-->>SH: compiled policies
    Note over SH: key specifiers stay in JS (the codecs use them),<br/>so do the fragment registry and policy storage
    opt first cache in this realm
        SH->>LD: decode the bundled bytes, initSync
        LD->>RS: instantiate (shared by every cache in the realm)
    end
    SH->>RS: newCache()
    RS-->>SH: handle (owns every table of this cache)
    SH->>RS: setPolicies(handle, descriptors, supertypes, epoch 0)
    SH-->>APP: the cache, synchronously
```

**What differs**

- **Validation throws**, at construction and in `cache.policies.addTypePolicies`, with an
  error that lists every offending path and links the migration guide. The whole argument
  is validated before any of it applies ([§7.3](03-design-in-depth.md#73-validation-and-the-policy-table)).
- **The WASM instance is created once per realm**, synchronously, from bytes shipped in the
  package; every cache shares it ([§16](03-design-in-depth.md#16-packaging-and-initialization)). This is not
  implemented yet: today the package throws on construction outside Jest and the probes
  (ADR 0001, F18).
- **Each cache is a handle** into the shared instance. Everything the cache allocates in
  Rust belongs to that handle, which is what makes disposal possible
  ([§14](03-design-in-depth.md#14-memory-and-ownership)).

### 5.2 The first response: a cold write

The board mounts with an empty cache. `cache-first` finds nothing, the network answers
with 5 000 tickets, and `QueryInfo.markQueryResult` writes them inside a `batch`
([Apollo architecture §8.4](../../research/architecture/08-client-pipeline.md#84-queryinfomarkqueryresult--the-write-path-and-the-feud-breaker)).

**In `InMemoryCache`**, `StoreWriter` walks the result along the query, builds a
`StoreObject` per entity, identifies each object, computes each field's store key, and
merges the result into the `Root` field by field, dirtying every new field
([Apollo architecture §4.9](../../research/architecture/04-store-writer.md#49-the-full-write-end-to-end)).
For 5 000 entities of eight scalar fields, the probe's shape, that is 83.41 ms and 92 MiB of
allocation.

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Apollo Client
        participant QI as QueryInfo
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant DOC as documents
        participant ENC as encoder
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    QI->>SH: batch({ update, onWatchUpdated })
    SH->>SH: txCount 0 to 1, broadcasts wait
    QI->>SH: writeQuery({ query: Board, variables, data })
    SH->>DOC: transformDocument(Board), then its plan id
    opt first time this document is seen
        DOC->>RS: compilePlan(selection structure)
        RS-->>DOC: plan id, cached against the DocumentNode
    end
    SH->>ENC: bind(plan, variables)
    Note over ENC: field keys for these variables, computed once<br/>and reused by every write and read with them
    ENC->>ENC: walk data along the plan
    Note over ENC: identify each object, format its dataId,<br/>intern strings by value, keep each meta object<br/>as a leaf slot, append integers to one buffer
    ENC->>RS: write(op buffer, target Root)
    Note over RS: stage every entity once, apply descriptors,<br/>compare with stored values by id, commit,<br/>dirty every field that changed
    RS-->>SH: ok
```

What the encoder hands over, for the first ticket. The format is experiment E10's to
decide, so this is only an illustration:

```text
JS interns strings by value; Rust only ever sees their ids:
  "Ticket:T1" = s12   "Login fails" = s14   "User:U7" = s16   'tickets({"status":"OPEN"})' = s30

WRITE    target=Root  plan=p1  binding=b1
ENTITY   s12                         Ticket:T1
  FIELD  __typename  STR   s3        "Ticket"
  FIELD  id          STR   s13       "T1"
  FIELD  title       STR   s14       "Login fails"
  FIELD  status      STR   s15       "OPEN"
  FIELD  assignee    REF   s16       User:U7
  FIELD  meta        SLOT  1         the JSON object itself stays in JS
ENTITY   s16                         User:U7
  FIELD  __typename  STR   s4        "User"
  FIELD  id          STR   s17       "U7"
  FIELD  name        STR   s18       "Ada"
  ... 4 999 more tickets ...
ENTITY   s0                          ROOT_QUERY
  FIELD  __typename  STR   s5        "Query"
  FIELD  s30         LIST  5000      REF s12, REF s19, ...
END
```

```mermaid
flowchart TB
    subgraph js["JavaScript: the encoder"]
        direction LR
        OBJ["result object<br/>parsed by the link"]:::ext
        WALK["walk along the plan<br/>one pass, no StoreObject,<br/>no per-field allocation"]:::write
        ID["identity<br/>keyFields, then dataId<br/>formatted as Apollo does"]:::write
        INT["interner<br/>string to id, by value"]:::store
        SLOT["leaf slots<br/>JSON blobs, custom scalars"]:::store
        BUF["op buffer<br/>integers only"]:::write
        OBJ --> WALK
        WALK --> ID --> INT --> BUF
        WALK --> SLOT --> BUF
    end

    subgraph rs["Rust: the write engine"]
        direction LR
        STAGE["stage<br/>each entity once"]:::write
        DESC["descriptors<br/>merge rules"]:::write
        REC["reconcile<br/>equal value ids<br/>keep the old value"]:::write
        COM["commit<br/>into the target level"]:::store
        DIRTY["dirty<br/>changed (entity, field)"]:::dirty
        STAGE --> DESC --> REC --> COM --> DIRTY
    end

    js ==>|"write(op buffer): one crossing"| rs

    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

**What differs**

- **One crossing per write**, carrying integers. Rust never walks the JS object and never
  decodes a string ([contract 4](../../adr/0004-declarative-policies-rust-engine.md#4-the-contracts)).
- **Ids and field keys are still Apollo's strings**, formatted by the same JS functions
  Apollo uses, so `extract()` output and `cache.identify()` stay byte for byte the same
  ([§8](03-design-in-depth.md#8-names-entity-ids-field-keys-and-interned-strings)).
- **The JSON blob is not copied or interned.** It stays in JS as the application's own
  object, and Rust stores its slot id ([§13](03-design-in-depth.md#13-the-frontier-the-javascript-objects-the-design-keeps)).
- **The rest of the write is Rust's**, with Apollo's semantics: two phases, each entity
  merged once, descriptors instead of merge functions ([§10](03-design-in-depth.md#10-the-write-engine)).
- The target for the encoder alone is 10 ms at this size, about 12 % of Apollo's cold
  write ([§19](04-getting-there.md#19-performance-and-memory-targets)).

### 5.3 Reading it back and watching it

Still inside the `batch`, `QueryInfo` reads the query back with `diff`, so that the data it
returns is the cache's version (read descriptors applied). Then the `batch` ends and the
broadcast delivers the result to the board's watch.

**In `InMemoryCache`**, `StoreReader.diffQueryAgainstStore` walks the query over the store.
Each selection set on each entity is an `optimism` memo entry that records every
`(entity, field)` it read, and each entry builds a new object (deeply frozen in development
builds, R3)
([Apollo architecture §5.1](../../research/architecture/05-store-reader.md#51-the-two-memoized-functions)).

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Apollo Client
        participant QI as QueryInfo
        participant OQ as ObservableQuery (Board)
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant MAT as materializer
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    QI->>SH: diff({ query: Board, variables, optimistic: true })
    SH->>RS: read(binding b1, ROOT_QUERY, view optimistic)
    Note over RS: memo miss: walk the plan over the store,<br/>record every (entity, field) read,<br/>build result nodes: root, list, one per ticket,<br/>User:U7 once
    RS-->>MAT: root node id + records of all new nodes
    MAT->>MAT: build frozen objects bottom-up,<br/>remember node to object and object to node
    MAT-->>QI: { result, complete: true }
    Note over SH: the update function returns, txCount 1 to 0
    SH->>RS: takeDirtiedWatches()
    RS-->>SH: [Board watch]
    SH->>RS: read(Board watch)
    RS-->>SH: the same root node: a memo hit
    SH->>QI: onWatchUpdated(watch, diff), which sets lastOwnDiff
    SH->>OQ: callback(diff)
    OQ->>OQ: diff is lastOwnDiff: drop it, this was our own write
```

What exists after the read, on each side of the boundary:

```mermaid
flowchart LR
    subgraph rs["Rust: result nodes, one per memo entry or sub-entry"]
        direction TB
        N1["n1: Board over ROOT_QUERY"]:::memo
        N2["n2: the tickets list"]:::memo
        N3["n3: Ticket:T1"]:::memo
        N4["n4: Ticket:T2"]:::memo
        N5["n5: User:U7<br/>under the assignee selection"]:::memo
        N1 --> N2
        N2 --> N3 & N4
        N3 --> N5
        N4 --> N5
    end

    subgraph js["JavaScript: the frontier, one frozen object per node"]
        direction TB
        O1["result object: n1"]:::read
        O2["tickets array: n2"]:::read
        O3["T1 object: n3"]:::read
        O4["T2 object: n4"]:::read
        O5["assignee object: n5<br/>one object for both tickets,<br/>as in Apollo"]:::read
        S1["T1.meta: the object the app<br/>wrote, kept as a leaf slot"]:::store
        O1 --> O2
        O2 --> O3 & O4
        O3 --> O5
        O4 --> O5
        O3 --- S1
    end

    rs ==>|"records of new nodes,<br/>materialized once each"| js

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

**Registering a watch.** `cache.watch(options)` binds the query's plan to its variables,
registers the watch in Rust's watch registry, and keeps a JS map from the `WatchOptions`
object to the watch id. The object itself is never copied, because Apollo Client sets
fields on it (`watcher`, `lastDiff`, `lastOwnDiff`) and expects to get the same object back
in `onWatchUpdated` ([§9.3](../../research/architecture/09-invariants-and-checklist.md#93-cross-boundary-requirements)).
`immediate: true` delivers the first result before `watch` returns (D6).

**What differs**

- **The memo and the dependency records are Rust's**, as integer pairs, rather than an
  `optimism` entry with a dependency-key string per field. That is where Apollo's
  4.4 KiB per entity per memo set goes ([§11](03-design-in-depth.md#11-the-reader-and-the-result-memo)).
- **JS builds each result object once**, when a read first returns its node, and reuses it
  for as long as the node lives. The same node always means the same object
  ([§13](03-design-in-depth.md#13-the-frontier-the-javascript-objects-the-design-keeps)).
- **The broadcast asks Rust which watches were dirtied**, rather than visiting every
  registered watch ([§12](03-design-in-depth.md#12-invalidation-and-broadcast)).

### 5.4 The next poll: one ticket changed

Five seconds later the poll returns the same 5 000 tickets, except that T1's title is now
"Login fails on Safari". As always after `JSON.parse`, every `meta` field is a new object,
equal to the stored one.

**In `InMemoryCache`**, the whole payload is written again (72.18 ms for the probe's
5 000-entity shape), the read-back recomputes T1, the list and the root (19.53 ms), and the
broadcast visits every watch.

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Apollo Client
        participant QI as QueryInfo
        participant OQ as Board watch
        participant FR as Detail watch (T1)
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant COD as codecs
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    QI->>QI: equal(result, last write): they differ
    QI->>SH: batch({ update, onWatchUpdated })
    QI->>SH: writeQuery(same query and variables)
    SH->>COD: encode: same plan and binding,<br/>every string found by value except the new title
    COD->>RS: write(op buffer)
    Note over RS: compare 5 000 tickets by value id:<br/>only T1.title differs.<br/>5 000 meta fields hold new objects: ask JS
    RS-->>COD: slot pairs that need equal()
    COD->>COD: equal(old meta, new meta) for each pair
    COD->>RS: commit(answers: all equal, keep the old objects)
    Note over RS: set T1.title, dirty (Ticket:T1, title),<br/>mark its readers and their parents stale,<br/>flag the watches whose roots are stale
    QI->>SH: diff (read-back)
    SH->>RS: read(b1, ROOT_QUERY, optimistic)
    Note over RS: recompute T1 (a new node), rebuild the list<br/>(4 999 children reused) and the root
    RS-->>COD: new root + records for 3 new nodes
    COD-->>QI: new result: new root, array and T1 object,<br/>4 999 ticket objects and the assignees ===
    Note over SH: the batch ends: broadcast
    SH->>RS: takeDirtiedWatches()
    RS-->>SH: [Board, Detail T1], not the badge
    SH->>SH: Board gate: new root node differs,<br/>so equal(last result, new result)
    SH->>OQ: callback, dropped as our own write
    SH->>FR: callback(new T1 object): the pane re-renders
```

Which result nodes change, and which JS objects survive:

```mermaid
flowchart LR
    subgraph before["After the first poll"]
        direction TB
        A1["n1 root"]:::read
        A2["n2 list"]:::read
        A3["n3 T1"]:::read
        A4["n4 T2 ... n5002"]:::read
        A5["n5 User:U7"]:::read
        A1 --> A2 --> A3 & A4
        A3 --> A5
        A4 --> A5
    end

    subgraph after["After the second poll"]
        direction TB
        B1["n11 root<br/>new"]:::dirty
        B2["n10 list<br/>new, 4 999 children reused"]:::dirty
        B3["n9 T1<br/>new: title changed"]:::dirty
        B4["n4 T2 ... n5002<br/>same nodes, same objects"]:::read
        B5["n5 User:U7<br/>same node, same object"]:::read
        B1 --> B2 --> B3 & B4
        B3 --> B5
        B4 --> B5
    end

    before ~~~ after

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Which watches the broadcast touches:

| Watch | `InMemoryCache` | `InMemoryCacheRs` |
| --- | --- | --- |
| Board | memo entry dirty → `diff` → `equal()` walk of the list → callback, dropped as its own write | the same steps; the re-read is Rust's and materializes 3 nodes |
| Detail (T1) | dirty → `diff` → `equal()` → callback → re-render | the same |
| Badge (reads only ids) | visited: a memo key is built (`canonicalStringify` and a `Trie` lookup), the entry is clean, so it stops there (gate 1) | not visited: it is not in the dirtied set |

**What differs**

- **Unchanged fields cost a comparison of two integers.** A list of references is one
  hash-consed value, so an unchanged list of 5 000 references compares in `O(1)`
  ([§9.3](03-design-in-depth.md#93-values-the-arena-and-two-ids-per-value)).
- **The JSON blobs still cost an `equal()` each**, in JS, as in Apollo. Polling hands over
  every blob as a new object, so this is a real cost that E10 measures
  ([§10.3](03-design-in-depth.md#103-leaf-slots-and-the-two-phase-commit)).
- **The re-read is proportional to what changed**, plus `O(N)` to build the new list array
  from cached children, which Apollo pays too. The target is 1 ms against 19.53 ms
  ([§19](04-getting-there.md#19-performance-and-memory-targets)).
- **The equality gate is skipped outright when the root node is the same** and runs
  Apollo's `equal()` otherwise. A node id can prove equality, never inequality
  ([§12.3](03-design-in-depth.md#123-the-broadcast-loop-and-its-gates)).

### 5.5 A poll where nothing changed

Through an `ObservableQuery`, an identical poll never reaches the cache: `QueryInfo` skips
the write ([§2.3](README.md#23-where-the-time-and-the-memory-go)). An identical payload still
arrives from other sources: a second query over the same tickets, a subscription,
`writeQuery` in application code, or the first poll after an `evict` or `modify` (which
reset the feud breaker).

```mermaid
flowchart TB
    P["a result arrives"]:::ext
    FB{"QueryInfo: equal to this<br/>query's last write?"}:::ext
    SKIP["no write at all<br/>the last diff is reused<br/><i>the same in both caches</i>"]:::store
    ENC["encoder walks the payload<br/>strings found by value"]:::write
    CMP["Rust compares by value id<br/>every field equal"]:::write
    SL{"leaf slots:<br/>the same object?"}:::write
    EQ["JS equal() per pair<br/>the old objects are kept"]:::write
    NONE["nothing dirtied:<br/>no watch flagged, nothing re-read,<br/>nothing materialized"]:::store

    P --> FB
    FB -->|"yes"| SKIP
    FB -->|"no, or not from an ObservableQuery"| ENC
    ENC ==>|"op buffer"| CMP
    CMP --> SL
    SL -->|"yes"| NONE
    SL -->|"no: new equal objects"| EQ --> NONE

    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

| Cost of an identical 5 000-ticket write | `InMemoryCache` (75.95 ms) | `InMemoryCacheRs` |
| --- | --- | --- |
| traversal | `processSelectionSet`, a `StoreObject` and a path array per entity and field | one encoder pass writing integers |
| identity | `identify` per object | the same, in the encoder |
| comparison | `equal()` on every object-valued field that is not `===`: lists, embedded objects, blobs | one integer comparison per field; `equal()` only for blobs |
| dirtying, re-read, broadcast | none | none |

### 5.6 A user edit through `cache.modify`

An agent creates a ticket, and the mutation's `update` function appends it to the cached
list, a pattern from Apollo's documentation:

```ts
update(cache, { data }) {
  cache.modify({
    fields: {
      tickets(existing = []) {
        const ref = cache.writeFragment({ data: data.createTicket, fragment: NEW_TICKET });
        return [...existing, ref];
      },
    },
  });
}
```

**In `InMemoryCache`**, `modify` looks up the entity, calls the modifier for each field
with the stored value, and merges the changed fields at the end
([Apollo architecture §2.7](../../research/architecture/02-normalized-store.md#27-modify--user-controlled-field-surgery)).
The nested `writeFragment` is an ordinary write that happens while `modify` is running.

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Application
        participant APP as update function
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant COD as codecs
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    APP->>SH: modify({ fields: { tickets } }) on ROOT_QUERY
    SH->>RS: the fields of ROOT_QUERY at the target level
    RS-->>SH: field keys + value ids
    SH->>COD: materialize the tickets value (per occurrence, frozen)
    SH->>APP: tickets(existing, details)
    Note over SH,RS: no Rust call is running while the modifier runs
    APP->>SH: writeFragment(new ticket): a separate, complete call
    SH->>COD: encode
    COD->>RS: write(op buffer)
    RS-->>SH: ok
    SH-->>APP: ref to Ticket:T5001
    APP-->>SH: return [...existing, ref]
    SH->>COD: encode the returned list
    COD->>RS: applyModify(changed fields)
    Note over RS: reconcile by value id, set,<br/>dirty (ROOT_QUERY, tickets(OPEN))
    SH->>SH: broadcast, unless inside a batch
```

**What differs**

- **The modifier runs between Rust calls, never inside one.** That is why it may call back
  into the cache (`writeFragment` above, `readField`, `identify`) with no re-entrancy
  machinery: the engine is idle whenever user code runs
  ([§6.3](03-design-in-depth.md#63-the-call-discipline-rust-calls-no-javascript)).
- **`existing` is frozen in every build.** Apollo freezes it only in development; in
  production, `existing.push(ref)` changes Apollo's store in place with no broadcast. Here
  the store is in Rust, so a mutated JS copy would silently disagree with it, and freezing
  turns the mistake into a `TypeError`. This is a registered drift
  ([§13.4](03-design-in-depth.md#134-values-handed-to-modifiers), [drift register](../../compatibility.md#decided-registered-when-implemented)).
- **Returning the value received changes nothing**, and returning an equal copy is encoded,
  gets the same value id and dirties nothing, as Apollo's reconciler does. `modify` still
  returns `true` in that case, as Apollo's does.

### 5.7 An optimistic mutation, confirmed or rolled back

The agent reassigns T2 to Grace (`User:U9`). The UI must show the change at once, then keep
the server's answer, or revert if the server refuses.

**In `InMemoryCache`**, `recordOptimisticTransaction` adds a `Layer` above the `Stump`, and
the mutation's writes land in it. Optimistic reads see the layer, root reads do not. On
success, one `batch` writes the server result to the `Root` and removes the layer; on
failure, `removeOptimistic` removes it. Removing a layer that is not on top replays every
layer above it ([Apollo architecture §6.5](../../research/architecture/06-reactivity.md#65-optimistic-lifecycle-end-to-end),
[§8.5](../../research/architecture/08-client-pipeline.md#85-mutations--optimistic-layer-final-write-root-field-scrub)).

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Apollo Client
        participant QM as QueryManager and QueryInfo
        participant OQ as Board watch (optimistic)
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    QM->>SH: recordOptimisticTransaction(tx, "12")
    SH->>RS: addLayer("12")
    RS-->>SH: level L12, above the Stump
    SH->>SH: keep tx as the replay function of "12"
    SH->>SH: run tx with the write target set to L12
    SH->>RS: write(ops for T2.assignee = User:U9, target L12)
    Note over RS: stored in L12 only. Dirties optimistic<br/>readers only: root readers never see a layer
    SH->>RS: takeDirtiedWatches()
    SH->>OQ: callback: T2 shows Grace at once

    alt the server confirms
        QM->>SH: batch({ update: write result, optimistic: false, removeOptimistic: "12" })
        SH->>RS: write(server result, target Root)
        Note over RS: a Root write dirties root and optimistic readers
        SH->>RS: removeLayer("12")
        RS-->>SH: layers above "12" that must be rebuilt: none
        SH->>RS: takeDirtiedWatches(): one broadcast for both
    else the server refuses
        QM->>SH: removeOptimistic("12")
        SH->>RS: removeLayer("12")
        Note over RS: dirty every field L12 shadowed
        SH->>RS: takeDirtiedWatches()
        SH->>OQ: callback: T2 shows Ada again
    end
```

The store's levels at the three moments:

```mermaid
flowchart LR
    subgraph t0["Before"]
        direction BT
        R0["Root<br/>T2.assignee = U7"]:::store
        S0["Stump<br/>empty"]:::store
        S0 -->|"parent"| R0
    end
    subgraph t1["While the mutation is in flight"]
        direction BT
        R1["Root<br/>T2.assignee = U7"]:::store
        S1["Stump"]:::store
        L1["Layer 12<br/>T2 snapshot, assignee = U9"]:::write
        L1 -->|"parent"| S1 -->|"parent"| R1
    end
    subgraph t2["After the server confirms"]
        direction BT
        R2["Root<br/>T2.assignee = U9"]:::store
        S2["Stump"]:::store
        S2 -->|"parent"| R2
    end
    t0 ~~~ t1 ~~~ t2

    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
```

**Two mutations in flight.** If the agent reassigns T2 (layer "12") and then T3 (layer
"13"), and "12" is confirmed first, layer "13" sits above the removed one and must be
rebuilt on the new parent by running its update function again. **Proposed** protocol,
since Rust cannot call the update function itself: `removeLayer("12")` drops the layer,
dirties what it shadowed and returns `["13"]`; the shell calls `addLayer("13")` and runs the
stored replay function with the write target set to the new level. This has to reproduce
Apollo's order and dirtying exactly (L4); [§9.1](03-design-in-depth.md#91-levels-root-stump-and-layers) has the
details and [Q3](04-getting-there.md#23-open-questions) asks the reviewers to check it.

**What differs**

- **Layers, their snapshots and tombstones live in Rust**; the update and replay functions
  stay in JS and run between Rust calls ([§9.1](03-design-in-depth.md#91-levels-root-stump-and-layers)).
- **Optimistic and root reads keep separate memo entries and separate objects**, as in
  Apollo (L2), so `ObservableQuery` can still tell an optimistic result from a root one
  ([§9.3 of the Apollo architecture guide](../../research/architecture/09-invariants-and-checklist.md#93-cross-boundary-requirements)).

### 5.8 Loading more: `fetchMore` and a merge descriptor

The activity log of T1 shows 20 entries; "load more" calls
`fetchMore({ variables: { offset: 20 } })`. With a field policy doing the merging, `fetchMore`
writes the new page with the combined variables inside a `batch`, and the original query
re-reads (`core/ObservableQuery.ts:958-987`).

**In `InMemoryCache`**, `offsetLimitPagination(["ticketId"])` gives `activity` the store key
`activity:{"ticketId":"T1"}` for every page (a `keyArgs` array produces the
`field:{...}` form, where a field with no policy gets `field({...})`), and its `merge`
function splices the new page into the existing array at `args.offset`.

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Apollo Client
        participant OQ as ObservableQuery (Activity, offset 0)
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant COD as codecs
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    OQ->>SH: batch: writeQuery(Activity, offset 20, limit 20, data)
    SH->>COD: bind(plan, variables)
    Note over COD: store key activity:{'ticketId':'T1'}<br/>offset and limit are not key arguments.<br/>The descriptor still gets offset = 20
    COD->>RS: write(op buffer)
    Note over RS: merge descriptor list offset:<br/>existing 20 references, incoming spliced at 20,<br/>a new list of 40, dirty (ROOT_QUERY, activity)
    SH->>RS: takeDirtiedWatches()
    RS-->>SH: [Activity watch]
    SH->>RS: read(Activity watch)
    RS-->>COD: new list node, records for 20 new entries
    COD-->>OQ: 40 entries, the first 20 objects ===
```

**What differs**

- **The merge rule is a descriptor that Rust runs**, `{ list: "offset" }`, with the exact
  semantics of `offsetLimitPagination`, including the holes it leaves when a page arrives
  out of order ([§7.2](03-design-in-depth.md#72-descriptors)).
- **Descriptors are tested against Apollo's helpers**, by twins of Apollo's tests that run
  the helper on `InMemoryCache` and the descriptor on `InMemoryCacheRs`
  ([§18](04-getting-there.md#18-how-correctness-is-proved)).
- **Writing back what was read stays safe.** A `readQuery` followed by a `writeQuery` of
  the same result must not append the page twice. Apollo prevents it with `isFresh`, and
  so does this design ([§10.2](03-design-in-depth.md#102-isfresh-writing-back-what-was-read)).

### 5.9 Deleting: `evict` and `gc`

A closed ticket leaves the board for good: `cache.evict({ id: "Ticket:T2" })`, then
`cache.gc()`.

**In `InMemoryCache`**, `evict` deletes the entity in the `Root` and in every layer, and
dirties each deleted field and then the entity's existence. The list that still references
T2 filters the dangling reference out on the next read (R4). `gc()` marks from the roots and
the retained ids and sweeps the rest. The memo entries that held T2 stay until the LRU
drops them: after `evict` and `gc()`, 21 of 46 MiB are still held
([Apollo performance §10.5](../../research/performance/10-memory.md#105-reclamation)).

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Application
        participant APP as app
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant COD as codecs and frontier
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    APP->>SH: evict({ id: "Ticket:T2" })
    SH->>RS: evict(Ticket:T2)
    Note over RS: delete T2 in the Root and every layer,<br/>dirty each field, then (T2, __exists)
    RS-->>SH: true
    SH->>RS: takeDirtiedWatches()
    RS-->>SH: [Board, Badge]: both read T2 through the list
    SH->>RS: read each
    Note over RS: the list still holds a reference to T2:<br/>dangling in a list, so it is filtered out<br/>and the read stays complete
    RS-->>COD: new list nodes without T2
    APP->>SH: gc()
    SH->>RS: gc()
    Note over RS: mark from the roots and retained ids,<br/>sweep what is unreachable (User:U9, if only T2<br/>referenced it), release the result nodes that<br/>depended on it, free values and strings<br/>whose counts reach zero
    RS-->>SH: removed ids + freed string and slot ids
    SH->>COD: forget the freed ids
    SH-->>APP: ["User:U9"]
```

**What differs**

- **Memory follows the data.** Result nodes that depend on an evicted or collected entity
  are released with it, and every table is reference-counted, so interned strings and
  stored values go when their last holder goes ([§14](03-design-in-depth.md#14-memory-and-ownership)).
- **`gc()` still marks from the roots**, as Apollo's does; its semantics (roots, retain
  counts, `__META.extraRootIds`) are tier 2.

### 5.10 Server rendering: `extract`, `restore` and disposal

The board is rendered on the server, one cache per request, and hydrated in the browser.

```ts
// server: one cache per request, freed when the block ends
export async function renderBoard(request: Request) {
  using cache = new InMemoryCacheRs(config);
  const client = new ApolloClient({ link: makeLink(request), cache, ssrMode: true });
  try {
    const html = await renderApp(client);
    return { html, state: cache.extract() };
  } finally {
    client.stop();
  }
}

// browser
const cache = new InMemoryCacheRs(config).restore(window.__APOLLO_STATE__);
```

```mermaid
sequenceDiagram
    autonumber
    box rgba(71, 85, 105, 0.10) Application
        participant SRV as server request
        participant BR as browser
    end
    box rgba(37, 99, 235, 0.10) InMemoryCacheRs, JavaScript
        participant SH as shell
        participant COD as codecs
    end
    box rgba(22, 163, 74, 0.10) Rust engine
        participant RS as engine
    end

    SRV->>SH: extract()
    SH->>RS: extract(Root)
    RS-->>COD: entity records: key ids, value ids, slot ids
    COD-->>SRV: NormalizedCacheObject with Apollo's keys<br/>and the app's own blob objects
    SRV->>SH: Symbol.dispose, when the block ends
    SH->>RS: free(handle)
    Note over RS: every table of this cache is freed at once.<br/>Later calls on it throw a disposed error
    SRV->>BR: HTML + state
    BR->>SH: restore(state)
    SH->>COD: encode the snapshot entity by entity,<br/>with no plan and no normalization
    COD->>RS: restore(op buffer)
```

**What differs**

- **`extract()` is a materialization**, `O(S · F)` in the store's size, where Apollo's is a
  shallow copy, `O(S)`. SSR pays it once per page ([ADR 0004, consequences](../../adr/0004-declarative-policies-rust-engine.md#consequences)).
- **`restore()` no longer adopts the snapshot's objects by reference**, a tier-3 change.
  Offset lists come back with `null` where a page was missing, as they do through JSON in
  Apollo ([§7.2](03-design-in-depth.md#72-descriptors)).
- **Disposal is deterministic.** JavaScript's garbage collector cannot see WASM memory, and a
  `FinalizationRegistry` callback may run late or never, so a server that builds a cache per
  request would leak with a finalizer alone. `cache[Symbol.dispose]()` frees everything the
  cache owns; the finalizer is a fallback. `ApolloClient` never disposes its cache, so the
  application does ([§14](03-design-in-depth.md#14-memory-and-ownership); [AGENTS.md](../../../AGENTS.md#package-boundaries)).
- **Open:** a snapshot has no selection sets, so `restore()` cannot tell an embedded object
  from a JSON blob ([Q4](04-getting-there.md#23-open-questions)).

### 5.11 Who did what

| Flow | JS shell | Codecs | Rust engine | User code, run between Rust calls |
| --- | --- | --- | --- | --- |
| construct | validate, load the WASM once | | new handle, policy table | |
| write | `txCount`, `batch`, document to plan | encode, intern, keep blobs as slots, compare slot pairs | stage, descriptors, reconcile, commit, dirty | |
| read, `diff` | document to plan | bind variables, materialize new nodes | memo lookup, read, record dependencies | |
| broadcast | loop over dirtied watches, gates, `onWatchUpdated` | materialize | dirtied watch set, reads | watch callbacks |
| `modify` | orchestrate the modifier calls | materialize values, encode returns | fields in, reconcile, dirty | modifiers |
| optimistic | layer ids, replay functions, write target | | layers, snapshots, tombstones, dirtying | update and replay functions |
| `evict`, `gc` | | forget freed ids | delete, mark and sweep, release | |
| `extract`, `restore` | | materialize, encode | walk or load the store | |
| dispose | the disposed flag | drop the frontier | free the handle | |

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Level 1: the idea](README.md) | [RFC 0001](README.md) | [Level 3: the design in depth](03-design-in-depth.md) |
