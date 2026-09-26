---
status: accepted
---

# The JS ↔ Rust-WASM boundary of `InMemoryCacheRs`

`InMemoryCacheRs` keeps **one authoritative normalized store** and keeps every piece of
user code, the reader and the dependency graph in JavaScript. Rust owns the store's index
and, later, the write engine. The two sides are *not* an eventually consistent pair:
Apollo reads its own writes synchronously, so every call into Rust returns the
invalidations it caused, and JavaScript applies them before any other code runs.

The first step is a measured experiment, not a port: a root-only Rust store behind a
`NormalizedCache`-shaped adapter, with Apollo's `StoreReader`, `StoreWriter` and `Policies`
unchanged on top (V0). What moves next is decided by V0's measurements.

The maintainer approved the amendment to AGENTS.md's Phase 2 and delegated the open
questions (A6 to A8, the gate thresholds) to `claude`; see [Resolution](#resolution). The
compatibility target this record assumes is [ADR 0002](0002-compatibility-target.md), and
WASM initialization is [ADR 0003](0003-wasm-initialization.md).

## Context

The maintainer asked how to split the cache between JS and Rust-WASM, what the interface
looks like, and whether the two sides could be treated as a distributed system, with Rust
owning consistent writes and JS eventually consistent. Two agents, a Claude Code session
and GPT-6 Astra (Codex), discussed it turn by turn under
[the brainstorm protocol](../agents/brainstorm-protocol.md), with the maintainer
moderating. Every fact below was verified against `apollo-client-sm/src/` (Apollo Client
4.2.11 at `ba511be`), against the performance guide, or by an experiment whose script is
reproduced in this record. The messages are cited as `#n`.

**Eventual consistency is ruled out** by F1: reads and writes are synchronous, and Apollo
reads its own writes within one call stack. Only notification is deferred (F2), and not
always.

## Decision

### The boundary

| Stays in JS | Moves to Rust (V0) | Moves to Rust later, if A8 justifies it |
| --- | --- | --- |
| all user code: `read`, `merge`, `keyFields`/`keyArgs` functions, modifiers, watch callbacks, replay closures, reactive variables (C3) | the store's index: which value is current for each `(level, entity, field)`, layers' snapshots and tombstones, `__exists`, the dirty report | the write engine (phase 2 and, later, normalization) |
| `StoreReader`, the read and broadcast memos, `CacheGroup` and all `optimism` dependencies (A4) | | a Rust reader with Rust-side dependencies (separately gated; parked) |
| policy `storage` objects (F16) | | |
| stored values other than `null`, booleans and numbers, as JS *slots* (A2) | | Rust-owned structured nodes, interned (A2, A6) |
| document identity and transforms (C3) | | |

### The contracts

1. **One store (C1).** No independently authoritative JS replica. In V0, the JS slot table
   is part of the store's physical representation: authoritative storage, freed only by
   Rust's refcount or a sweep, never by an LRU. It is distinct from the disposable
   query-result cache, and memory accounting keeps the two apart. A JS materialization
   cache may approach the working set's size; A8 measures and bounds it.
2. **Stored-value identity (F8).** `get` returns the same JS object for an unchanged
   value. `StoreReader` keys its list memo on the stored array object, duck-types
   `supportsResultCaching` and `makeCacheKey`, and calls `store.group.depend` directly, so
   the adapter exposes all three.
3. **State model (A2, F9, F10).**
   - Per level, an entity is *absent* (ask the parent), a *tombstone* (Layers only) or a
     *snapshot*.
   - A Layer's snapshot captures the fields that exist when it is taken, so later parent
     writes to those fields stay hidden from optimistic reads.
   - Within a snapshot, a field is *Absent* (`get` asks the parent) or *Present*, and a
     Present field may hold `undefined` at any level. Apollo's cleanup rules decide when
     it is stored: a Layer keeps it as a mask, and the Root drops it only while
     `resultCaching` is on.
   - `lookup`, `toObject` and `modify` see only a snapshot's own fields.
   - `DELETE` and `INVALIDATE` never reach storage.
   - Reconciliation uses `@wry/equality` (`-0` equals `0`, `NaN` equals `NaN`), and
     dirtying uses `!==`, so a `NaN` rewrite always dirties. Bitwise f64 comparison breaks
     both.
   - Own-property presence, stored-value identity, reconciliation equality and
     invalidation are four separate contracts; no encoding may collapse them.
4. **Invalidation (A3, C2).** Every boundary return carries an owned dirty report (a JS
   copy in V0). JS applies it before control reaches Apollo or user code, on exceptional
   exits too, before Apollo's `finally` broadcast.
   - **Entries** are `(group, entity, storeFieldName, kind)`, with the kind `setDirty` or
     `forget` (D3). Writes dirty only the writing group (L5).
   - **Invalidations without value changes** (`INVALIDATE`, a field `evict` that deletes
     nothing, `removeLayer`'s comparison) are reported separately from value changes.
   - **Policies-dependent expansion** (bare field names without `keyArgs`, the root
     `__typename` exemption) uses mutation-time facts.
   - **Size and deduplication.** The report scales with the invalidation entries emitted.
     It is never deduplicated across a checkpoint where JS could have read in between.
   - **Zero-copy** is allowed only if nothing re-enters, grows memory or reuses the buffer
     until the report has been consumed (F13).
5. **Order (F12).** A write engine keeps Apollo's order for every user callout (key
   functions, merge functions and anything they call, development warnings), walks
   `incomingById` in its insertion (post-)order, and flushes before each callout. A merge
   function that reads mid-write must see exactly the entities merged before it.
6. **Reentrancy and failure (A5, F15).**
   - **Rust never calls user code**, hidden callouts included: getters, coercion, and
     `Map`/`Set` iteration inside JS equality.
   - **Phase 2 is resumable**, in this order: Rust returns its request and report, JS
     flushes, JS runs the callback, then JS resumes Rust. V0's rule is that no borrow
     spans an import; the necessary rule is that no conflicting live borrow spans
     re-entrant code.
   - **When a callback throws**, JS still flushes and discards the continuation, then
     rethrows the original value, non-`Error` values included. Entities already applied
     stay applied (W1, F6), and the cache stays healthy.
   - **Continuations** are operation-local and nestable, keep their captured operands and
     never replay a callback.
   - **Exceptions are classified by origin**, not by class.
   - **Panic-free is a target**, enforced with checked inputs, `Result`s, an audit and
     tests. A trap poisons the whole WASM instance, which every cache in the realm shares
     (F19).
7. **Equality (A6).**
   - **Hash-consing, not hash plus compare.** Bottom-up interning by child ids is exact,
     and a match costs O(1) without a second O(B) pass.
   - **Intern only what the writer already walks** (references, lists, embedded objects
     with selection sets), so a list of references compares as `Vec<EntityId>` with no JS
     walk.
   - **Opaque JSON scalars keep JS `equal()`** until A8 shows otherwise.
   - **A raw-bytes ingestion link is out of scope**: the cache never sees bytes, and
     `no-cache` callers need the parsed `data` anyway (F17).

### Migration order (A1)

1. The contract above.
2. V0: the root-only Rust store behind the adapter, measured under the next steps. It is
   an experiment, not a commitment to ship an intermediate regression.
3. If V0's numbers justify it, the write engine moves beside the store. Layers, gc and
   extract/restore follow as the parity suite needs them.
4. The production order and encoding are decided by those measurements, not fixed now.

This replaces AGENTS.md's Phase 2 wording ("replace `StoreReader`, `StoreWriter` and
`src/internal/` modules with Rust-WASM"), which names the reader and writer but not the
store, and moves the reader last and conditional. The maintainer approved the
amendment, and AGENTS.md carries it.

## Next steps: the V0 prototype (A8)

**Correctness oracle.** Each case runs against Apollo's `InMemoryCache` and
`InMemoryCacheRs` and must match. The scripts are reproduced under
[Evidence](#evidence).

| Case | Pins |
| --- | --- |
| write-back of a read result, and of a JSON copy of it | F3 (`isFresh`, merge calls 0 vs 1) |
| a merge function calling `readQuery` mid-write, in both selection orders | F12, contract 5 |
| an optimistic layer then a root write to an uncaptured field; a layer `DELETE`; a field the parent gains later | F9 |
| `resultCaching: false` with a root `DELETE` | F9 |
| `-0`/`0` and `NaN` rewrites | F10 |
| a warm re-read returns `===` list items (the list memo hits) | F8 |
| a nested write inside a merge function; a merge function that throws after earlier entities were merged | contract 6, F6 |
| development console output, byte for byte except [registered drifts](../compatibility.md) | `npm run probe:parity`, ADR 0002 |

**Measurements**, from the performance probe (`docs/probes/cache-performance-probe.mjs`) at
N = 5 000, against Apollo's baselines [performance §1.3]: write cold 83.41 ms, write of an
identical payload 75.95 ms, read cold 155.23 ms, read warm 3.8 µs, read after one dirty
field 19.53 ms.

- boundary crossings per operation, and the time spent in them;
- cold reads field-at-a-time against entity prefetch (A4);
- the dirty report's size, and the flush crossings on a payload heavy with merge functions;
- the heap: the slot table and the result cache, each against Apollo's at N = 5 000 and
  N = 20 000;
- the seeded gate shapes: an unchanged write, a one-item update, policies heavy with
  callbacks;
- the gzipped `.wasm` size, and the first construction's decode-and-compile time
  (ADR 0003).

A crossing itself is cheap: about 5 ns per call with integer arguments, which is what a JS
method call costs, against the roughly 2 µs per field that Apollo spends on a cold write
and 3.9 µs per field on a cold read (F20, E9). The boundary's real costs are strings and
objects, which V0 avoids by passing interned integer ids.

**Gates.** The thresholds are `claude`'s, under the maintainer's delegation; they are
starting values, to be tightened once V0 exists.

- **Correctness is hard.** Every oracle case, `npm test` and `npm run probe:parity` pass
  for what V0 implements, except registered drifts (ADR 0002).
- **Warm reads stay flat**: independent of N, and within 2× of Apollo's 3.8 µs. A
  regression here means contract 2 is broken, not that V0 is slow.
- **V0 costs at most 1.25× Apollo** on probe sections 1 and 2 at N = 5 000: write cold
  ≤ 104 ms, write identical ≤ 95 ms, read cold ≤ 194 ms, read after one dirty field
  ≤ 24 ms. That leaves a budget of roughly 500 ns of boundary overhead per field. V0 is a
  scaffold, but not a slow one: past the budget, the adapter is fixed (prefetch,
  batching) before any write-engine work starts.
- **The write engine goes ahead only if** a prototype of it, placed beside the Rust store,
  is at least 1.5× faster than Apollo on both write columns of probe section 1 at
  N = 5 000, and at least 1.2× faster on the one-item update and the callback-heavy policy
  shape, with every conversion, report and flush counted, and without slowing section 2's
  reads by more than 10%. Otherwise the plan stops at V0 and is revisited.
- **The `.wasm` stays under 1 MB gzipped** (ADR 0003).

## Considered options

- **An eventually consistent JS side** (the maintainer's opening question). Rejected by
  F1: `markQueryResult` writes and then `diff`s in one `batch`, `updateQuery` reads then
  writes, and a `writeQuery({ broadcast: false })` must be visible to the next
  `readQuery`. What observables and React tolerate is *delivery* latency (F2), and the
  design keeps that unchanged.
- **Store last, with value representation, plan execution and the writer first**
  (`gpt`'s seed position). Revised by its author in #2 to "contract first, adapter-first
  experiment, measurement-gated migration". A Rust writer in front of a JS `EntityStore`
  hands back one `StoreObject` per entity and leaves `equal()` in JS (#1, #3).
- **A Rust reader with the dependency graph in JS, or the reverse.** Parked, not
  rejected. Dependency capture is ambient (F14), so a split has to ship each recompute's
  dependencies across the boundary. A Rust executor emitting transient traces into one JS
  graph remains possible (#16).
- **A Rust store holding decoded copies with a JS materialization cache.** Deferred to
  A8's comparison with V0's slots. Slots give identity, exotic leaves (F5) and no UTF-8
  conversion for free, but leave structural comparison in JS.
- **A worker-hosted store (C5).** Deferred: every API is synchronous (F1).

## Resolution

The maintainer answered the four escalated questions after the brainstorm closed.

1. **AGENTS.md's Phase 2: approved.** AGENTS.md is meant to follow the project's growing
   understanding, and it now carries the migration order above.
2. **Initialization:** keep `ApolloCache`'s interface and make adoption effortless.
   [ADR 0003](0003-wasm-initialization.md) decides it: the constructor runs `initSync`
   from bytes shipped in the package. The 4 KB main-thread limit, which this record listed as
   unverified, is out of date: Chrome 115 raised it to 8 MB.
3. **Correctness stays a hard gate**, but the target is now "close to `InMemoryCache`",
   not byte-identical. [ADR 0002](0002-compatibility-target.md) draws the line: the client
   contract and the user-authored surface hold; incidental behaviour may drift through a
   register.
4. **A6 to A8:** delegated to `claude`. A6 and A8 stand as written above, and A7 is
   resolved by ADR 0003.

## Established facts

Paths under `cache/`, `core/`, `link/` and `utilities/` are in `apollo-client-sm/src/`.

| Id | Fact | Evidence |
| --- | --- | --- |
| F1 | Reads and writes are synchronous (`reset` alone returns `Promise<void>`), and Apollo reads its own writes in the same call stack: `markQueryResult` writes then `diff`s inside one `batch`; `updateQuery` reads then writes; `writeQuery({ broadcast: false })` is visible to the next `readQuery`. | architecture §8.4; `cache/inmemory/inMemoryCache.ts` (`write`, `batch`); `cache/core/cache.ts:197` |
| F2 | Notification is mostly deferred: `ObservableQuery`'s watch callback compares synchronously, then `scheduleNotify()` runs `notify` in a `setTimeout`. `QueryManager.broadcastQueries` calls `notify()` synchronously. React hooks read through `useSyncExternalStore`. | `core/ObservableQuery.ts:715`, `:1760`; `core/QueryManager.ts:866-869`; `react/hooks/useQuery.ts:859` |
| F3 | The writer skips staging an object the reader handed out unchanged (`isFresh`), so its merge functions do not run. Losing JS identity on the way in is observable. | `cache/inmemory/writeToStore.ts:480`; `readFromStore.ts:251`; experiment E1 |
| F4 | `Policies.identify` reads through `policies.cache["data"]`, so while Apollo's `Policies` is used, `cache.data` stays `NormalizedCache`-shaped. | `cache/inmemory/policies.ts:454` |
| F5 | `cloneDeep` copies arrays and every `[object Object]` value, class instances included; `Date` and `Map` leaves keep their identity. | `utilities/internal/cloneDeep.ts`; `cache/inmemory/__tests__/readFromStore.ts:2183` |
| F6 | Phase 2 of a write is not atomic (W1): a throwing merge function leaves earlier entities merged. | `cache/inmemory/writeToStore.ts:197-255` |
| F7 | Removing a lower optimistic layer replays the JS `update` functions of the layers above it. | `cache/inmemory/entityStore.ts` (`Layer.removeLayer`); architecture §2.10 |
| F8 | `StoreReader` duck-types its store (`supportsResultCaching`, `makeCacheKey`), keys the list memo on the stored array object, and calls `store.group.depend` directly. | `cache/inmemory/readFromStore.ts:146`, `:163`, `:176`, `:187`, `:350-352`; `entityStore.ts:554-556`, `:603`, `:697` |
| F9 | The state model of contract 3. | `cache/inmemory/entityStore.ts:72-99`, `:123`, `:140-184`, `:257-260`, `:323`; experiments E2, E3 |
| F10 | Reconciliation by `@wry/equality`, dirtying by `!==`: a stored `-0` survives a write of `0`; a `NaN` rewrite always dirties. | `@wry/equality` 0.5.7 `lib/index.js:66-73`; `entityStore.ts:157`; experiment E4 |
| F11 | `isReference` checks only `typeof obj.__ref === "string"`, so references can carry other properties, and gc traverses them. Child refs are computed lazily at gc and dropped per merged entity. | `utilities/graphql/storeUtils.ts:22-26`; `cache/inmemory/entityStore.ts:143`, `:491-521` |
| F12 | Phase 2 walks `incomingById` in insertion (post-)order, running an entity's merge functions and then `store.merge`, which dirties at once. A merge function's `readQuery` sees the entities merged before it, through a memo warmed before the write. | `cache/inmemory/writeToStore.ts:197`, `:202`, `:255`, `:491`; `entityStore.ts:200`; experiment E5 |
| F13 | For non-shared memory, `WebAssembly.Memory#grow` detaches the old `ArrayBuffer` and every view over it. | experiment E6 |
| F14 | Dependency capture is ambient: `optimism`'s `dep` registers into the recomputing entry through `parentEntrySlot`, so `store.get`, `has`/`canRead`, user `read` functions under `cacheSlot` and reactive variables all attach to it. `maybeBroadcastWatch` is a `wrap` over `diff`. | optimism 0.18.1 `lib/dep.js:10-20`, `lib/entry.js:122`, `:140`; `cache/inmemory/policies.ts:932`; `reactiveVars.ts:88`; `inMemoryCache.ts:121-123`, `:576` |
| F15 | With wasm-bindgen 0.2.127 and `panic="abort"` (the wasm32 default), re-entering an exported struct during a `&mut self` method throws "recursive use of an object detected". A `catch` import returns a JS throw to Rust as `Err` and the object survives. Without `catch`, the throw unwinds through Rust with no destructors, and the object is unusable for good. A panic traps (`RuntimeError: unreachable`) and bricks its object. | experiment E7; `wasm-bindgen-0.2.127/src/rt/mod.rs:575-588` |
| F16 | Policy `storage` is a JS `Trie` on the Root, keyed by entity id or embedded-object identity plus field. | `cache/inmemory/entityStore.ts:729-731`, `:827`; `policies.ts:917-928` |
| F17 | The cache never sees response bytes: HttpLink `JSON.parse`s the body. A `no-cache` result goes from the link to the caller without touching the cache. | `link/http/parseAndCheckHttpResponse.ts:159`, `:170`; `core/QueryInfo.ts:232-243` |
| F18 | `new InMemoryCacheRs()` throws outside Jest: it calls the web-target glue synchronously, nothing initializes it, and the package exports no initializer. | `src/InMemoryCacheRs.ts:48`, `:102`; `src/index.ts`; `pkg/fast_gql_cache_rs.js:11-18`, `:68`; experiment E8 |
| F19 | The glue keeps one module-level instance, shared by every cache in a realm. Exported structs get `free()`, `Symbol.dispose` and a `FinalizationRegistry`. | `pkg/fast_gql_cache_rs.js:118`, `:138`; E7's generated glue |
| F20 | A call from JS into a wasm-bindgen export with integer arguments costs about 5 ns (a free function or a `&self` method, borrow guard included), about the same as a JS method call; Apple M4, Node 24.21.0. | experiment E9 |

Chrome refused synchronous main-thread compilation over 4 KB until Chrome 115, which
raised the limit to 8 MB ([ADR 0003](0003-wasm-initialization.md)); other browsers are
unchecked. Whether linear memory ever shrinks is not verified, and nothing here relies on
it.

## Evidence

Node 24.21.0 (`.nvmrc`), `@apollo/client` 4.2.11; run with `node <script>.mjs` from a
directory where `@apollo/client` resolves. Development builds (`--conditions=development`)
gave the same output wherever that was checked (E1, E2, E3).

<details>
<summary>E1: <code>isFresh</code> write-back (F3)</summary>

```js
import { InMemoryCache } from "@apollo/client/cache";
import { gql } from "@apollo/client";
let mergeCalls = 0;
const cache = new InMemoryCache({
  typePolicies: { Post: { fields: { tags: {
    merge(existing = [], incoming) { mergeCalls++; return [...existing, ...incoming]; },
  } } } },
});
const query = gql`{ post { id tags } }`;
cache.writeQuery({ query, data: { post: { __typename: "Post", id: 1, tags: ["a"] } } });
const r = cache.readQuery({ query });
mergeCalls = 0;
cache.writeQuery({ query, data: r });
console.log("write-back of read result :", cache.extract()["Post:1"].tags, "merge calls:", mergeCalls);
mergeCalls = 0;
cache.writeQuery({ query, data: JSON.parse(JSON.stringify(r)) });
console.log("write-back of a JSON copy :", cache.extract()["Post:1"].tags, "merge calls:", mergeCalls);
```

```
write-back of read result : [ 'a' ] merge calls: 0
write-back of a JSON copy : [ 'a', 'a' ] merge calls: 1
```

</details>

<details>
<summary>E2: layer snapshots and field tombstones (F9)</summary>

```js
import { InMemoryCache } from "@apollo/client/cache";
import { gql } from "@apollo/client";
const cache = new InMemoryCache();
const q = gql`{ post { id title body } }`;
cache.writeQuery({ query: q, data: { post: { __typename: "Post", id: 1, title: "t0", body: "b0" } } });
cache.recordOptimisticTransaction((c) => {
  c.writeFragment({ id: "Post:1", fragment: gql`fragment T on Post { title }`, data: { __typename: "Post", title: "t-opt" } });
}, "layer1");
cache.writeQuery({ query: q, data: { post: { __typename: "Post", id: 1, title: "t0", body: "b1" } } });
console.log("root read        :", cache.readQuery({ query: q, optimistic: false }).post);
console.log("optimistic read  :", cache.readQuery({ query: q, optimistic: true }).post);
console.log("layer1 own entry :", cache.extract(true)["Post:1"]);
cache.recordOptimisticTransaction((c) => {
  c.modify({ id: "Post:1", fields: { body: (_, { DELETE }) => DELETE } });
}, "layer2");
const d = cache.diff({ query: q, optimistic: true, returnPartialData: true });
console.log("after layer2 DELETE body, optimistic diff complete:", d.complete, "result:", d.result.post);
```

```
root read        : { __typename: 'Post', id: 1, title: 't0', body: 'b1' }
optimistic read  : { __typename: 'Post', id: 1, title: 't-opt', body: 'b0' }
layer1 own entry : { __typename: 'Post', id: 1, title: 't-opt', body: 'b0' }
after layer2 DELETE body, optimistic diff complete: false result: { __typename: 'Post', id: 1, title: 't-opt' }
```

</details>

<details>
<summary>E3: a field the parent gains later, and <code>undefined</code> in the Root (F9; by <code>gpt</code>, #6 and #8)</summary>

```js
import { InMemoryCache } from "@apollo/client/cache";
import { gql } from "@apollo/client";
const c = new InMemoryCache();
c.writeFragment({ id: "Post:1", fragment: gql`fragment S on Post { id title }`, data: { __typename: "Post", id: 1, title: "t0" } });
c.recordOptimisticTransaction((x) => x.modify({ id: "Post:1", fields: { title: () => "opt" } }), "L");
c.writeFragment({ id: "Post:1", fragment: gql`fragment B on Post { body }`, data: { __typename: "Post", body: "added" } });
console.log("optimistic previously absent field:", c.readFragment({ id: "Post:1", fragment: gql`fragment R on Post { title body }`, optimistic: true }));
console.log("layer snapshot:", c.extract(true)["Post:1"]);

for (const resultCaching of [true, false]) {
  const r = new InMemoryCache({ resultCaching });
  r.restore({ ROOT_QUERY: { x: 1, y: 2 } });
  r.modify({ fields: { x: (_, { DELETE }) => DELETE } });
  const obj = r.extract().ROOT_QUERY;
  console.log({ resultCaching, ownX: Object.hasOwn(obj, "x"), keys: Object.keys(obj) });
}
```

```
optimistic previously absent field: { __typename: 'Post', title: 'opt', body: 'added' }
layer snapshot: { __typename: 'Post', id: 1, title: 'opt' }
{ resultCaching: true, ownX: false, keys: [ 'y' ] }
{ resultCaching: false, ownX: true, keys: [ 'x', 'y' ] }
```

</details>

<details>
<summary>E4: <code>-0</code> and <code>NaN</code> (F10)</summary>

```js
import { InMemoryCache } from "@apollo/client/cache";
import { gql } from "@apollo/client";
const q = gql`{ a b }`;
const cache = new InMemoryCache();
cache.writeQuery({ query: q, data: { a: -0, b: NaN } });
cache.writeQuery({ query: q, data: { a: 0, b: 1 } });
console.log("after a:-0→0 write, stored a is -0:", Object.is(cache.extract().ROOT_QUERY.a, -0));

const qb = gql`{ b }`;
const c2 = new InMemoryCache();
c2.watch({ query: qb, optimistic: false, callback: () => {}, immediate: true });
const dirties = (b) => {
  let n = 0;
  c2.batch({ update: (c) => c.writeQuery({ query: qb, data: { b } }), onWatchUpdated: () => (n++, false) });
  return n > 0;
};
c2.writeQuery({ query: qb, data: { b: 7 } });
console.log("rewrite 7→7 dirtied the watch:", dirties(7));
c2.writeQuery({ query: qb, data: { b: NaN } });
console.log("rewrite NaN→NaN dirtied the watch:", dirties(NaN));
```

```
after a:-0→0 write, stored a is -0: true
rewrite 7→7 dirtied the watch: false
rewrite NaN→NaN dirtied the watch: true
```

</details>

<details>
<summary>E5: a merge function reading mid-write (F12)</summary>

```js
import { InMemoryCache } from "@apollo/client/cache";
import { gql } from "@apollo/client";
const qa = gql`{ a { id name } }`;
let seen;
const cache = new InMemoryCache({
  typePolicies: { B: { fields: { note: {
    merge(_existing, incoming, { cache }) { seen = cache.readQuery({ query: qa })?.a.name; return incoming; },
  } } } },
});
const q = gql`{ a { id name } b { id note } }`;
cache.writeQuery({ query: q, data: { a: { __typename: "A", id: 1, name: "old" }, b: { __typename: "B", id: 1, note: "n0" } } });
console.log("warm read before write:", cache.readQuery({ query: qa }).a.name);
cache.writeQuery({ query: q, data: { a: { __typename: "A", id: 1, name: "new" }, b: { __typename: "B", id: 1, note: "n1" } } });
console.log("merge function for B.note saw a.name =", seen);
const q2 = gql`{ b { id note } a { id name } }`;
cache.writeQuery({ query: q2, data: { b: { __typename: "B", id: 1, note: "n2" }, a: { __typename: "A", id: 1, name: "newer" } } });
console.log("with B selected first, merge saw a.name =", seen, "(A not yet merged)");
```

```
warm read before write: old
merge function for B.note saw a.name = new
with B selected first, merge saw a.name = new (A not yet merged)
```

</details>

<details>
<summary>E6: <code>memory.grow</code> detaches views (F13)</summary>

```js
const m = new WebAssembly.Memory({ initial: 1 });
const before = m.buffer;
const view = new Uint32Array(before, 0, 4);
m.grow(1);
console.log("old buffer byteLength after grow:", before.byteLength, "detached:", before.detached);
console.log("old view length after grow:", view.length, "new buffer byteLength:", m.buffer.byteLength);
```

```
old buffer byteLength after grow: 0 detached: true
old view length after grow: 0 new buffer byteLength: 131072
```

</details>

<details>
<summary>E7: re-entry, throwing callouts and panics under wasm-bindgen 0.2.127 (F15, F19)</summary>

A `cdylib` crate with `wasm-bindgen = "=0.2.127"` and the repository's `rust-toolchain.toml`,
built with `cargo build --offline --release --target wasm32-unknown-unknown`, then
`wasm-bindgen --target nodejs` (wasm-pack's cached 0.2.127 CLI).

```rust
use std::cell::Cell;
use wasm_bindgen::prelude::*;

thread_local! { static DROPS: Cell<u32> = const { Cell::new(0) }; }
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) { DROPS.with(|d| d.set(d.get() + 1)); }
}

#[wasm_bindgen]
extern "C" {
    pub type Callback;
    #[wasm_bindgen(method, js_name = call)]
    fn call_nocatch(this: &Callback, ctx: &JsValue);
    #[wasm_bindgen(method, catch, js_name = call)]
    fn call_catch(this: &Callback, ctx: &JsValue) -> Result<(), JsValue>;
}

#[wasm_bindgen]
pub struct Store { log: Vec<u32> }

#[wasm_bindgen]
impl Store {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Store { Store { log: Vec::new() } }
    pub fn len(&self) -> usize { self.log.len() }
    pub fn callout_nocatch(&mut self, cb: &Callback) {
        let _g = Guard; self.log.push(1); cb.call_nocatch(&JsValue::NULL); self.log.push(2);
    }
    pub fn callout_catch(&mut self, cb: &Callback) -> bool {
        let _g = Guard; self.log.push(1);
        let ok = cb.call_catch(&JsValue::NULL).is_ok();
        self.log.push(2); ok
    }
    pub fn panic_now(&mut self) { let _g = Guard; self.log.push(9); panic!("core bug"); }
}

#[wasm_bindgen]
pub fn drops() -> u32 { DROPS.with(|d| d.get()) }
```

The driver (`run.cjs`, requiring the generated glue renamed to `.cjs`):

```js
const { Store, drops } = require("./pkg/reentry.cjs");
const show = (label, fn) => { try { console.log(label, "->", fn()); } catch (e) { console.log(label, "-> threw:", String(e.message || e)); } };

// 1. Re-entry during a callout, catch import.
let s = new Store();
let inner;
show("1 catch, re-entrant len()", () => s.callout_catch(() => { try { s.len(); inner = "ok"; } catch (e) { inner = String(e.message || e); throw e; } }));
console.log("  inner call saw:", inner, "| drops:", drops(), "| len after:", s.len());

// 2. Callout throws, catch import: Rust sees Err, finishes, drops its guard.
s = new Store();
show("2 catch, callback throws", () => s.callout_catch(() => { throw new Error("user boom"); }));
console.log("  drops:", drops(), "| len after:", (() => { try { return s.len(); } catch (e) { return "threw: " + e.message; } })());

// 3. Callout throws, NO catch import: the exception unwinds through Rust frames.
s = new Store();
const before = drops();
show("3 nocatch, callback throws", () => s.callout_nocatch(() => { throw new Error("user boom"); }));
console.log("  guard dropped:", drops() > before, "| len after:", (() => { try { return s.len(); } catch (e) { return "threw: " + e.message; } })());
console.log("  another fresh call on the same object:", (() => { try { return s.callout_catch(() => {}); } catch (e) { return "threw: " + e.message; } })());

// 4. A Rust panic (panic=abort, the target's default) while holding &mut self.
s = new Store();
show("4 panic", () => s.panic_now());
console.log("  len after:", (() => { try { return s.len(); } catch (e) { return "threw: " + e.message; } })());
const t = new Store();
console.log("  a different object after the panic:", (() => { try { return t.len(); } catch (e) { return "threw: " + e.constructor.name + ": " + e.message; } })());
```

```
1 catch, re-entrant len() -> false
  inner call saw: recursive use of an object detected which would lead to unsafe aliasing in rust | drops: 1 | len after: 2
2 catch, callback throws -> false
  drops: 2 | len after: 2
3 nocatch, callback throws -> threw: user boom
  guard dropped: false | len after: threw: recursive use of an object detected which would lead to unsafe aliasing in rust
  another fresh call on the same object: threw: recursive use of an object detected which would lead to unsafe aliasing in rust
4 panic -> threw: unreachable
  len after: threw: recursive use of an object detected which would lead to unsafe aliasing in rust
  a different object after the panic: 0
```

`rustc --print cfg --target wasm32-unknown-unknown` prints `panic="abort"`. The generated
glue defines `Store.prototype.free`, sets `Symbol.dispose` to it, and registers
`new FinalizationRegistry(ptr => wasm.__wbg_store_free(ptr >>> 0, 1))`.

</details>

<details>
<summary>E8: the web-target entry without initialization (F18)</summary>

```js
const pkg = await import("<repo>/pkg/fast_gql_cache_rs.js"); // after `npm run wasm:dev`
try { console.log(pkg.convict_in_the_game()); }
catch (e) { console.log("call before init threw:", e.constructor.name + ": " + e.message); }
```

```
call before init threw: TypeError: Cannot read properties of undefined (reading '__wbindgen_free')
```

</details>

<details>
<summary>E9: crossing cost (F20)</summary>

E7's crate plus:

```rust
#[wasm_bindgen]
pub fn add1(x: u32) -> u32 { x.wrapping_add(1) }

#[wasm_bindgen]
impl Store {
    pub fn get(&self, i: u32) -> u32 { i ^ (self.log.len() as u32) }
}
```

```js
const { Store, add1 } = require("./pkg/reentry.cjs");
const s = new Store();
const jsGet = { log: [], get(i) { return i ^ this.log.length; } };
function time(label, fn, n) {
  for (let i = 0; i < 1e5; i++) fn(i);
  const t0 = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < n; i++) acc ^= fn(i);
  console.log(label.padEnd(34), (Number(process.hrtime.bigint() - t0) / n).toFixed(2), "ns/call");
}
for (let r = 0; r < 3; r++) {
  time("wasm free fn add1(u32)", (i) => add1(i), 2e7);
  time("wasm method store.get(&self,u32)", (i) => s.get(i), 2e7);
  time("js method obj.get(i)", (i) => jsGet.get(i), 2e7);
}
```

The last of three rounds (the first round's free-function figure, 2.22 ns, was a
warm-up outlier):

```
wasm free fn add1(u32)             4.69 ns/call
wasm method store.get(&self,u32)   5.51 ns/call
js method obj.get(i)               4.19 ns/call
```

</details>

## Provenance

- **Agreed by both peers:** A1 (#3, ack #4), A2 (#9, ack #10), A3 (#13, ack #14), A4
  (#16, ack #17) and A5 (#19, ack #20), including every refinement recorded above.
- **Closed by `claude` alone:** the other peer became unavailable after #21, and the
  maintainer asked `claude` to finish alone. A6 was `claude`'s position in #21 with no
  reply. A7 (parked) and A8 (the next steps) were never discussed.
- **Resolved by the maintainer** after the close: see [Resolution](#resolution).
- **Dissent:** none was recorded. `gpt` did not post a final `ack` or a dissent, because
  it was unavailable at the close.
