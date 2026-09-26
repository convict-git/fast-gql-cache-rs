# Behaviour drift from `InMemoryCache`

Every behaviour in which `InMemoryCacheRs` deliberately differs from Apollo's
`InMemoryCache` (`@apollo/client@4.2.11`). The rules for adding an entry are in
[ADR 0002](adr/0002-compatibility-target.md): only tier-3 behaviours drift, and only with a
measured reason, a migration note, and the tests that pin the new behaviour, all in the
same PR.

## Adopted

None. `InMemoryCacheRs` currently matches `InMemoryCache` everywhere the test suite and
the behaviour probe look.

## Candidates

Tier-3 behaviours known to be expensive or awkward to reproduce in the Rust core. Listing
one here adopts nothing; each needs its own PR under the rules above.

| Behaviour today | Possible drift | Why it might pay | Evidence |
| --- | --- | --- | --- |
| An optimistic layer snapshots the whole entity it writes, so a later root write to a field the layer never wrote stays invisible to optimistic reads | per-field overlay: layers hold only the fields they wrote | simpler, smaller layers; arguably the more expected result | ADR 0001 F9, E2 |
| Rewriting `NaN` dirties the field every time (reconciled by `@wry/equality`, dirtied by `!==`) | treat an equal `NaN` as unchanged | one comparison rule instead of two | ADR 0001 F10, E4 |
| With `resultCaching: false`, the Root keeps a deleted field as an own `undefined` | always delete it | one cleanup rule for both modes | ADR 0001 F9, E3 |
| Development warnings are compared byte for byte, including their order relative to user output | keep each warning's condition, but allow different wording or order | frees the write engine from reproducing console interleaving | `docs/probes/parity.mjs` |
| `extract()` object key order follows insertion into JS objects | any stable order | lets Rust keep its own map order | ADR 0002, tier 3 |
