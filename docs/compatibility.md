# Behaviour drift from `InMemoryCache`

Every behaviour in which `InMemoryCacheRs` deliberately differs from Apollo's
`InMemoryCache` (`@apollo/client@4.2.11`). The rules for adding an entry are in
[ADR 0002](adr/0002-compatibility-target.md): only tier-3 behaviours drift, and only with a
measured reason, a migration note, and the tests that pin the new behaviour, all in the
same PR.

## Adopted

None. `InMemoryCacheRs` currently matches `InMemoryCache` everywhere the test suite and
the behaviour probe look.

## Decided, registered when implemented

[ADR 0004](adr/0004-declarative-policies-rust-engine.md) decides these drifts. Each moves
to **Adopted**, with its pinning test, in the PR that implements it.

| Behaviour in `InMemoryCache` | In `InMemoryCacheRs` | Why | Migration |
| --- | --- | --- | --- |
| A write that throws while comparing stored values (a getter, or `equal()` overflowing on a JSON blob nested ~10 000 levels) has already committed the entities before it, in production builds | nothing from the write is committed; the original value is rethrown and watches still broadcast | the comparison runs in JS between Rust's staging and commit (ADR 0004 contract 2) | none needed for passive data; do not rely on partial writes |
| Stored lists, references and embedded objects handed to `modify` are frozen in development only; mutating one in production changes the store silently | frozen in every build, so mutating one throws; leaf values the application wrote (JSON blobs, `Date`s) are never frozen | the store lives in Rust; a mutated JS copy would disagree with it (ADR 0004 section 5) | return a new value from the modifier instead of mutating the one received |

## Unsupported

Configuration and inputs outside ADR 0004's declarative profile. These are not drift.
This section specifies the accepted profile; the checks arrive with ADR 0004's step 2.
Until then today's delegating cache still accepts all of it. From step 2, the constructor,
`addTypePolicies` and `addPossibleTypes` reject each configuration below, naming every
offending path; input values stay documented as unsupported without being checked.

| Unsupported | Rejected from step 2? | Migration |
| --- | --- | --- |
| custom `read` functions | yes | a read descriptor; `@client` fields with `LocalState` resolvers for computed fields; transform values in a link or the component |
| custom `merge` functions | yes | a merge descriptor (`true`, `false`, list, offset, Relay, keep-existing); otherwise normalize in a link or on the server |
| function-valued `keyFields` / `keyArgs` | yes | a `KeySpecifier` array, or `false` |
| `dataIdFromObject` | yes | `keyFields` per type; the default `__typename:id` / `_id` is built in |
| fuzzy `possibleTypes` (an entry that is not a plain type name, which Apollo compiles into a `RegExp`) | yes | list the subtypes by name |
| `resultCaching: false` | yes | omit it; result caching is always on |
| reactive variables read inside the cache (only possible from a `read` function) | with `read` functions | `useReactiveVar` in the component, or local state written with `writeQuery` |
| written values with getters, Proxies, custom `valueOf`/`toString`, or class instances other than `Date` | no: documented only, since checking a Proxy runs its traps | write plain JSON data and `Date`s |

## Candidates

Tier-3 behaviours known to be expensive or awkward to reproduce in the Rust core. Listing
one here adopts nothing; each needs its own PR under the rules above.

| Behaviour today | Possible drift | Why it might pay | Evidence |
| --- | --- | --- | --- |
| An optimistic layer snapshots the whole entity it writes, so a later root write to a field the layer never wrote stays invisible to optimistic reads | per-field overlay: layers hold only the fields they wrote | simpler, smaller layers; arguably the more expected result | ADR 0001 F9, E2 |
| Rewriting `NaN` dirties the field every time (reconciled by `@wry/equality`, dirtied by `!==`) | treat an equal `NaN` as unchanged | one comparison rule instead of two | ADR 0001 F10, E4 |
| With `resultCaching: false`, the Root keeps a deleted field as an own `undefined` | always delete it (moot under ADR 0004, which makes `resultCaching: false` unsupported) | one cleanup rule for both modes | ADR 0001 F9, E3 |
| Development warnings are compared byte for byte, including their order relative to user output | keep each warning's condition, but allow different wording or order | frees the write engine from reproducing console interleaving | `docs/probes/parity.mjs` |
| `extract()` object key order follows insertion into JS objects | any stable order | lets Rust keep its own map order | ADR 0002, tier 3 |
