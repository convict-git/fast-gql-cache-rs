# Ledger: the JS ↔ Rust-WASM boundary

Kept by the scribe (`claude`) under [the protocol](PROTOCOL.md). Every change names the
message (`#seq`) that justifies it; `gpt` may object to any change, which reopens it.
Seeded from the two answers the moderator relayed before the brainstorm, one from each
peer.

Paths are repository-relative; `apollo-client-sm/src/` is Apollo Client 4.2.11.

## Established facts

Accepted unless a message challenges one; a challenge reopens it.

| Id | Fact | Evidence |
| --- | --- | --- |
| F1 | Every `ApolloCache` method is synchronous, and Apollo reads its own writes in the same call stack. `markQueryResult` writes, then `diff`s, inside one `batch`; `updateQuery` reads, then writes; a `writeQuery({ broadcast: false })` is visible to the next `readQuery`. The JS side may hold stale entries internally but must never return one. | architecture §8.4; `cache/inmemory/inMemoryCache.ts` (`write`, `batch`) |
| F2 | Notification is the deferred part. `ObservableQuery`'s watch callback compares synchronously and then calls `scheduleNotify()`, i.e. `setTimeout(() => this.notify(true), 0)`, and `notify` re-reads the cache. React hooks read through `useSyncExternalStore`. | `core/ObservableQuery.ts:715`, `:1760`; `react/hooks/useQuery.ts:859`, `react/hooks/useFragment.ts:235` |
| F3 | The writer skips staging an object the reader handed out unchanged (`isFresh`), so that entity's merge functions do not run. Losing JS object identity on the way in is observably wrong. | `cache/inmemory/writeToStore.ts:480`; experiment below |
| F4 | `Policies.identify` reads through `policies.cache["data"]`. While we delegate to Apollo's `Policies`, `cache.data` must stay `NormalizedCache`-shaped. | `cache/inmemory/policies.ts:454` |
| F5 | `cloneDeep` copies only arrays and plain objects. A `Date`, `Map` or `BigInt` leaf is stored and returned by reference in both builds. Apollo's own test pins `toBe(now)` for a `read` function's `Date`. | `utilities/internal/cloneDeep.ts`; `cache/inmemory/__tests__/readFromStore.ts:2183` |
| F6 | Phase 2 of a write is not atomic (W1). A throwing merge function leaves the entities merged before it in the store. | architecture §4 intro; `cache/inmemory/writeToStore.ts` |
| F7 | Removing a lower optimistic layer replays the JS `update` functions of the layers above it. | `cache/inmemory/entityStore.ts` (`Layer.removeLayer`); architecture §2.10 |

<details>
<summary>F3 experiment (4.2.11; production and development builds agree)</summary>

```js
// Save as .brainstorm/.scratch/isfresh.mjs; run `node .brainstorm/.scratch/isfresh.mjs`
// (add --conditions=development for the development build).
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
write-back of read result : [ 'a' ]       merge calls: 0
write-back of a JSON copy : [ 'a', 'a' ]  merge calls: 1
```

</details>

## Converged direction

| Id | Point |
| --- | --- |
| C1 | One authoritative normalized store. The JS side holds derived results, plus the identity-stable stored values its reader needs. It never holds a second full `EntityStore` and never serves stale data. |
| C2 | Invalidation is synchronous: a changed dependency is invalid before any later read or callback can observe it. Delivery timing (F2) is unchanged. |
| C3 | User code stays in JS: `read`, `merge`, `keyFields` and `keyArgs` functions, modifiers, reactive variables, watch callbacks and replay closures. So does document identity. |
| C4 | Before committing, prototype one representative path and measure the full boundary cost: input conversion, Rust work, callbacks, materialization and invalidation. |
| C5 | A worker-based authoritative store is deferred. |

## Agenda

| Id | Question | Status |
| --- | --- | --- |
| A1 | **Migration order.** Rust store first, behind a `NormalizedCache` adapter (`claude`), or value representation, plan execution and the writer first with the store last (`gpt`)? Changing AGENTS.md's Phase 2 needs the moderator's approval. | open |
| A2 | **Ingestion and value representation.** A JS walk guided by the compiled plan, with the `isFresh` identity check (F3)? How to represent absent, `undefined`, `null`, `DELETE`, `INVALIDATE`, layer tombstones, strings and non-JSON leaves (F5)? | open |
| A3 | **Invalidation protocol.** When do dirty keys cross: before any user code runs (`claude`), or when a mutation completes? Also `__exists` forgetting (D3), and reactive variables and `evict({ fieldName })` as sources that change no stored data. | open |
| A4 | **Reader and dependency ownership.** Must dependency tracking live with whichever side executes reads? | open |
| A5 | **Reentrancy and failure.** No borrow held across a callout; imports declared `catch`; preserving W1 (F6); panic policy. | open |
| A6 | **Equality of structured values.** Hash-consing versus hash plus compare. Is an opt-in raw-bytes ingestion link in scope? | open |
| A7 | **Packaging and lifetimes.** Synchronous constructor versus browser initialization, `dispose`, memory growth. A candidate to park. | open |
| A8 | **The prototype.** Cases, measurements and pass/fail gates; this becomes the ADR's next steps. | open |

## Changes

| Message | Change |
| --- | --- |
| — | seeded |
