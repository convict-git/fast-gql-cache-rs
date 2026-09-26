# Handoff to the `claude` peer

You continue a brainstorm that a cloud Claude Code session prepared. That session read
every chapter of `docs/architecture/` and `docs/performance/`. It checked Apollo's source
and ran the F3 experiment. It could not take part itself, because the board lives on the
maintainer's machine. You are now the `claude` peer and the scribe.

The positions below are that session's. They are yours to change when the evidence says
so. Conceding a point is a good outcome, and winning by volume is not.

Read [the protocol](../../agents/brainstorm-protocol.md) and the [ledger](ledger.md)
first.

## What the moderator asked

Brainstorm how to move forward with the implementation:

- which components stay in JS, which go to Rust-WASM, and what the interface between them
  is;
- whether to treat the two sides as a distributed system, with Rust owning consistent
  writes and the JS side eventually consistent. The moderator's argument was that
  observables and React re-renders already tolerate eventual consistency.

They asked to be corrected with facts. They want shortcomings and edge cases raised, above
all where they threaten the current interface.

## The two answers the brainstorm starts from

**Both agreed:**

- Eventual consistency is wrong for the cache API, which must read its own writes
  synchronously (F1). Only delivery is deferred (F2).
- The right model has one authoritative store. The JS side holds results that are
  invalidated synchronously and rebuilt when read (C1, C2).
- User code stays in JS (C3). Prototype before committing (C4). Defer a Worker (C5).

**GPT-6 Astra added:**

- Three separate timelines: a write becomes visible, observers are notified, React renders.
- "Consistent writes" must not turn into atomic writes (F6).
- Reactive variables are a second source of invalidation.
- Absent, `undefined`, `null` and the sentinels need distinct representations.
- Hashing needs collision-safe equality.
- Plans cannot bind keys that depend on variables or policy functions.
- Rebuilding a changed array of N items as a new JS array costs O(N) at minimum.
- Its migration order: value representation and plan execution first, then the writer and
  the reader, with storage ownership last.

**The cloud Claude added:** the traps listed at the end of this file, the store-first order
(A1), the flush point for dirty keys (A3), the rule that dependencies live with the reader
(A4), and F3.

## Positions per agenda item

**A1.** See [message 0001](0001-claude.md).

**A2: ingestion and value representation.**

- Only JS can walk the incoming object tree cheaply, and F3 requires checking object
  identity (the reader's `knownResults` plus a memo peek) before Rust sees the payload.
  So the plan is a JS walk guided by the compiled plan. It feeds Rust integers: interned
  `dataId`s and `storeFieldName`s, entity and field structure, and slots for leaf values.
- Leaves stay JS values in a JS-side table. That keeps `Date`, `BigInt`, `undefined` and
  `-0` exact, preserves identity (F5), and avoids UTF-8 conversion.
- Rust compares primitives it holds. Opaque leaves (JSON scalars, `Date`s) are compared
  with Apollo's `equal` in JS, which costs the same as today.
- Build ids and field keys in JS: number formatting, `JSON.stringify` escaping and
  `canonicalStringify` key order then match Apollo for free.
- Open question: how Rust compares string leaves without a leaf interner that grows
  forever. Confidence: medium on the direction, low on the details.

**A3: invalidation protocol.**

- Every return from Rust carries the keys it dirtied, and JS applies them before any user
  code runs, not only when a mutation completes. The reason: a merge function receives
  `cache` and can call `readQuery` in the middle of a write. In Apollo, an earlier
  entity's `store.merge` has already dirtied the memo by then.
- A resumable write (Rust pauses at each entity that has a merge function) gives this for
  free.
- `__exists` means forget, not dirty (D3).
- `evict({ fieldName })` dirties even when no data changes (architecture §2.8).
- Reactive variables stay JS, in `optimism`, while the reader stays JS.

**A4: reader and dependency ownership.**

- Dependencies live with whoever executes reads.
- A Rust reader with JS dependencies would have to report every read's dependency list
  back so JS can rebuild `optimism` entries, which duplicates the graph.
- So: a JS reader with JS dependencies first. A Rust reader later brings Rust dependencies
  and takes reactive variables and field evictions as outside inputs.
- A later Rust reader can also fix the O(D²) clean-report climb (performance §3.3).

**A5: reentrancy and failure.**

- Never hold a mutable borrow across a call into JS. Keep staged data separate from
  committed data.
- Declare every import that can run user code `catch`, restore invariants, and rethrow
  from the boundary.
- Preserve W1: no rollback.
- The core must be panic-free.

**A6: equality of structured values.**

- Bottom-up hash-consing is exact: each node is interned by its children's ids, so
  equality is O(1) after the O(B) decode, with no second walk.
- The real limit: the cache never sees raw bytes, because `HttpLink` has already parsed
  them. That contradicts the "while the response is decoded" assumption in performance
  §9.4 #1. A raw-bytes link would have to be an opt-in option in `InMemoryCacheRsConfig`.

**A7: packaging and lifetimes.** Lower priority; fine to park. The traps are below.

**A8: the prototype.** Add these three gates to GPT's list (unchanged write, one-item
update, policies heavy with callbacks):

1. the F3 write-back case;
2. a merge function that calls `cache.readQuery` in the middle of a write;
3. the boundary cost of the adapter's cold read against Apollo's 155 ms at 5 000 entities
   (performance §1.3).

## Traps, with how well each is established

Re-verify a `[belief]` before you assert it as verified.

| Trap | Status |
| --- | --- |
| `Policies` reads `cache["data"]` (F4); `getMemoryInternals` reaches into `storeReader`, `maybeBroadcastWatch` and `addTypenameTransform` by name | verified |
| Watches must be visited in `Set` insertion order: `onWatchUpdated` order and delivery counts are probed | verified in the docs (architecture §6) |
| Development console output must match byte for byte, including its order relative to user callbacks (`probe:parity`) | verified: `docs/probes/parity.mjs` |
| wasm-bindgen guards `&mut self` exports and throws "recursive use of an object detected which would lead to unsafe aliasing in rust" | belief; GPT cited the struct-binding design doc |
| A JS exception thrown from an import unwinds through Rust frames without running destructors unless the import is declared `catch` | belief |
| With `panic=abort`, a Rust panic traps and leaves the instance unusable | belief |
| Chrome refuses a synchronous `new WebAssembly.Module` over 4 KB on the main thread, so the web target's `initSync` fails there | belief |
| `Atomics.wait` throws on the browser main thread | belief |
| WASM linear memory never shrinks; `memory.grow` detaches typed-array views over it | belief |
| Lone surrogates become U+FFFD crossing into Rust | GPT cited the wasm-bindgen string docs |
| JS and Rust format numbers differently (`1e21` is `"1e+21"` in JS); `canonicalStringify` sorts by UTF-16 code units, unlike Rust's `str` | belief |
| Whether wasm-bindgen 0.2.127 (pinned in `wasm/Cargo.lock`) frees exported structs through a FinalizationRegistry by default | unknown; check the generated glue |
| A JS object held by Rust that can reach the cache forms a cycle invisible to both garbage collectors | belief |

## Environment notes

- The repository's `postinstall` runs `patch-package` against `@apollo/client`; the tests
  need that patch.
- `pkg/` (the WASM build) must be generated before typecheck and tests (AGENTS.md).
- The Codex sandbox may block network access. The board needs none.
