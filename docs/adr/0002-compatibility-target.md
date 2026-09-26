---
status: accepted
---

# Compatibility target: close to `InMemoryCache`, not byte-identical

`InMemoryCacheRs` guarantees two things without exception: the `ApolloCache` contract that
Apollo Client depends on, and the configuration and policy semantics that users write code
against. Everything else `InMemoryCache` does incidentally may drift, one documented entry
at a time, when the drift buys measured performance or a real simplification. Until now
the project aimed at a byte-identical drop-in (`probe:parity` compares output byte for
byte). The maintainer relaxed that to "close to `InMemoryCache`, with a migration that
costs users little". This record says where the line is and why.

## Why the line falls where it does

**Apollo Client itself needs only the `ApolloCache` contract.** Its production code
(`core/`, `react/`, `local-state/`, `masking/`, `link/`) reaches the cache only through
the `ApolloCache` interface. That is `fragmentMatches`, `lookupFragment`, and the optional
`resolvesClientField` and `getMemoryInternals`. Nothing tests `instanceof InMemoryCache`
or reads `cache.policies` [verified: `git grep` over `apollo-client-sm/src` outside
`cache/inmemory/` and tests]. On top of the interface, the client relies on a handful of
behaviours, listed in
[architecture §9.3](../architecture/09-invariants-and-checklist.md#93-cross-boundary-requirements),
and on synchronous read-your-writes (ADR 0001, F1). One example: `QueryInfo` monkey-patches
`evict`, `modify` and `reset` on the cache instance [verified:
`core/QueryInfo.ts:68-80`, `:136-138`]. Breaking any of these breaks applications, so they
are **tier 1**.

**User code is the migration cost.** An application's `InMemoryCache` configuration
(`typePolicies`, `keyFields`, `keyArgs`, `read`/`merge` functions, `possibleTypes`,
reactive variables) encodes its data model. A semantic change there costs every adopter
work, and it often fails silently, as data corruption rather than an error:

- a merge function that runs once more appends a page twice (ADR 0001, F3, E1);
- a different `keyFields` ordering changes entity ids and breaks restoring an extracted
  snapshot (P2, S5).

These semantics are **tier 2**, and held to the same bar as tier 1.

**Result identity is performance, not correctness.** React reads Apollo state through
`useSyncExternalStore`, which needs stable snapshots. Both paths that feed it gate on deep
equality rather than on identity: `watchFragment` keeps its `currentResult` unless
`!equal(currentResult, result)` [verified: `cache/core/cache.ts:561`], and
`ObservableQuery` does the same with its stable last result [verified:
`core/ObservableQuery.ts:714`, `:754`]. So R2's `===` stability saves re-renders and deep
comparisons; it does not prevent render loops. It remains a performance target (ADR 0001,
contract 2), not a compatibility guarantee. (Apollo itself gives it up under LRU eviction.)

**The rest is observable only at the edges.** It shows up in optimistic reads racing root
writes, in `NaN` payloads, in development-only console text, or in reaching into private
fields. Nothing in Apollo Client's API or production code depends on it. That is
**tier 3**.

## The tiers

| Tier | Holds | Examples |
| --- | --- | --- |
| **1. Client contract** (hard) | always | synchronous read-your-writes (F1); architecture §9.3's cross-boundary requirements; §9.1's invariants that the client observes: D4–D7, L2, L3, L5, R4–R6, S4 |
| **2. User-authored surface** (hard) | always | `InMemoryCacheConfig` option shapes; identity (P1–P3, S2, S3); `read`/`merge`/modifier semantics and options (`readField`, `toReference`, `canRead`, `storage`, `DELETE`, `INVALIDATE`), including how often merge functions run (W2–W5, F3); `possibleTypes` (P5); reactive variables (P4); `evict`/`gc`/`retain` semantics; `extract()`/`restore()` contents (S5); `cache.policies`' public methods; mid-write visibility for callbacks that read (F12) |
| **3. Incidental** (may drift) | until a register entry says otherwise | the entity-snapshot capture of optimistic layers (F9); `NaN` rewrites always dirtying (F10); the Root keeping `undefined` when `resultCaching` is off (F9); non-atomic phase 2 (W1, F6); development warning text and its interleaving with user output; `getMemoryInternals` shape; key order inside `extract()`; private fields (`cache["data"]`, `storeReader`, `watches`); `===` result stability (R2) |

## Rules for a drift

1. It is tier 3. Moving anything out of tiers 1–2 needs the maintainer.
2. It buys something measured (benchmark or probe numbers in the PR) or removes real
   complexity from the Rust core.
3. It is recorded in [the drift register](../compatibility.md) in the same PR, with the
   old and new behaviour, the reason, a migration note for users, and the tests and probe
   lines that now pin the new behaviour.
4. The oracle stays Apollo's `InMemoryCache`: `npm test` and `npm run probe:parity` pass
   except for registered drifts. The parity check will compare against Apollo with the
   register's exceptions applied, never against a re-recorded baseline of our own output.

## Consequences

- The tests adapted from Apollo's `InMemoryCache` suite stay the oracle for tiers 1–2.
  Porting more of that suite (`entityStore`, `writeToStore`, `readFromStore`, `policies`,
  `optimistic`) becomes part of each phase, because tier 2 is only as strong as its tests.
- The biggest cost in ADR 0001, the resumable write engine that never calls user code,
  stays. Merge and key functions are tier 2, so the engine must run them in Apollo's order
  with the store visible as Apollo shows it.
- Tier 3 drifts are opt-in simplifications, not a licence: none is adopted by this record.
  Each candidate in the register has to earn its entry.
