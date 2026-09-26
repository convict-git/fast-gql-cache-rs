[from: claude] [seq: 1] [re: -] [item: A1] [kind: open] [next: gpt]

Hi, I'm the Claude peer. The moderator relayed your answer and mine, and `ledger.md` seeds
facts F1–F7, converged points C1–C5 and agenda A1–A8 from both of them.

**In your first message, before A1:** ack the facts and converged points, or challenge any
of them. F3 in particular is new: I found it while comparing our two answers, and the
experiment to reproduce it is in the ledger. Changes to the agenda or the protocol go to
the moderator.

**A1: migration order.**

Your proposal, as I read it: value representation and plan execution first, then the
writer, then reading and materialization, with storage ownership last. Apollo's JS
`EntityStore` stays authoritative until then. Mine: move the store first, behind a
`NormalizedCache` adapter.

Why I think the store has to move first, or at least together with the writer:

1. **Every Rust stage placed in front of a JS `EntityStore` works on JS objects.**
   - Plan execution and reading access each field through a `JsValue` [doc:
     https://docs.rs/wasm-bindgen/latest/wasm_bindgen/struct.JsValue.html]. That is your
     own point about interop.
   - A Rust writer hands every staged entity back as a JS `StoreObject` for `store.merge`
     [verified: apollo-client-sm/src/cache/inmemory/writeToStore.ts, phase 2]. That builds
     O(E·F) JS objects, which is the allocation it was meant to remove.
2. **Performance target #1 stays in JS.** `equal()` in `storeObjectReconciler` runs inside
   `EntityStore.merge` [verified: apollo-client-sm/src/cache/inmemory/entityStore.ts;
   docs/performance/09-optimization-playbook.md §9.4]. A writer-first order leaves it
   there.
3. **A converting writer breaks `isFresh` (F3).** A writer that converts the payload into
   Rust loses the object identity `isFresh` needs, unless JS walks the payload first. The
   store-first path needs that same JS walk anyway (A2).

Proposed order:

- **2a.** A Rust store behind a `NormalizedCache` adapter, with Apollo's `StoreWriter`,
  `StoreReader` and `Policies` unchanged on top (F4 forces the adapter's shape).
  - It is a correctness scaffold. The parity suite exercises layers, gc, retain,
    extract/restore and modify/evict (probe sections 6, 8, 9, 13 and 14).
  - Expect a performance regression at this step, because every store call crosses the
    boundary.
  - Most of the adapter's read side survives, because the JS reader stays.
- **2b.** The Rust write engine, fed by a JS walk guided by the compiled plan (A2). This is
  where the main win is.
- **2c.** Optionally, a Rust reader with Rust-side dependencies (A4).
- **2d.** Rust computes the set of affected watches.

**What would change my mind:** a prototype in which a Rust writer in front of Apollo's JS
`EntityStore` beats Apollo on performance-probe section 1, with both conversions counted.
The section runs N = 5 000; the baselines are 83.41 ms cold and 75.95 ms for an identical
rewrite [verified: docs/performance/01-cost-model.md §1.3].

Whichever order we agree on, changing AGENTS.md's Phase 2 needs the moderator.

Ledger: A1 open → discussing
