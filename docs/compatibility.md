# Compatibility with `InMemoryCache`

What changes when an application moves from Apollo Client's `InMemoryCache`
(`@apollo/client@4.2.11`) to `InMemoryCacheRs`. Read this before you migrate. It has two
parts:

- **[Unsupported features](#unsupported-features)**: what `InMemoryCacheRs` rejects,
  ignores or cannot provide. Your application either does not use it, or has to change.
- **[Behaviour drift](#behaviour-drift)**: what is supported but deliberately behaves
  differently, each difference with its reason and a migration note.

Everything else is meant to behave as it does in `InMemoryCache`, following the target in
[ADR 0002](adr/0002-compatibility-target.md). How to add or change an entry is in
[Maintaining this document](#maintaining-this-document).

## Unsupported features

Each entry says what is unsupported, how you will notice, and what to do instead. The
reason is folded under the entry, under **Why**.

### Status

| Status | Meaning |
| --- | --- |
| **Proposed** | An ADR under review plans it. It may still change or be dropped. |
| **Decided** | An accepted ADR decides it. The code may not enforce it yet. |
| **Enforced** | The code rejects the feature, or cannot provide it, since the version named in the entry. |

Nothing is released yet; the first release is v2 of
[ADR 0004](adr/0004-declarative-policies-rust-engine.md#migration-order-and-gates). Today's
development build still delegates to Apollo's own implementation and accepts everything
below. The configuration checks arrive with ADR 0004's step 2.

**Migrating a configuration.** Most function-valued policies have a declarative
replacement, and the entries below list them. After v1, the **migration skill**, an agent
skill for coding agents such as Claude Code and Cursor, applies these replacements to your
`typePolicies` and points to the alternative where there is none
([ADR 0004, maintainer decisions](adr/0004-declarative-policies-rust-engine.md#maintainer-decisions)).
If a `read` or `merge` function of yours expresses an idiom other applications share and no
descriptor fits it, [request a descriptor](https://github.com/convict-git/fast-gql-cache-rs/issues/new?template=descriptor-request.yml).

### Summary

| # | Feature | Status | Instead |
| --- | --- | --- | --- |
| [U1](#u1-read-functions) | `read` functions in field policies | Decided | a read descriptor, or a `LocalState` resolver |
| [U2](#u2-merge-functions) | `merge` functions | Decided | `merge: true`/`false`, or a merge descriptor |
| [U3](#u3-keyfields-and-keyargs-functions) | `keyFields` and `keyArgs` functions | Decided | a key specifier array, or `false` |
| [U4](#u4-dataidfromobject) | `dataIdFromObject` | Decided | `keyFields` per type |
| [U5](#u5-reactive-variables-read-by-the-cache) | reactive variables read by the cache | Decided | `useReactiveVar`, or local state in the cache |
| [U6](#u6-fuzzy-possibletypes) | pattern entries in `possibleTypes` | Decided | list every subtype by name |
| [U7](#u7-resultcaching-false) | `resultCaching: false` | Decided | remove the option |
| [U8](#u8-written-values-that-are-not-plain-data) | written values with getters, Proxies, custom coercion, or classes other than `Date` | Decided | write JSON data and `Date`s |
| [U9](#u9-runtimes-without-webassembly) | runtimes without WebAssembly | Decided | keep `InMemoryCache` there |
| [U10](#u10-browsers-that-refuse-synchronous-webassembly-compilation) | browsers that refuse synchronous WebAssembly compilation (Chrome before 115) | Decided | keep `InMemoryCache` there |
| [U11](#u11-content-security-policies-without-wasm-unsafe-eval) | a Content Security Policy without `'wasm-unsafe-eval'` | Decided | allow `'wasm-unsafe-eval'` |
| [U12](#u12-instanceof-inmemorycache) | `cache instanceof InMemoryCache` | Decided | check for `ApolloCache` |
| [U13](#u13-inmemorycache-internals) | `InMemoryCache` internals (`cache["data"]`, …) | Decided | the public `ApolloCache` API |
| [U14](#u14-cachepolicies-beyond-four-methods) | `cache.policies` beyond four methods | Decided | the cache's own methods |

### Cache configuration

#### U1. `read` functions

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)), checked from its step 2

**Unsupported:** a `read` function in a field policy, including the shorthand
`fields: { name(existing) { … } }`.

**You will notice:** `new InMemoryCacheRs(config)` and `cache.policies.addTypePolicies()`
throw, and the error names every offending path (`typePolicies.Query.fields.feed.read`).
TypeScript reports it at compile time.

**Instead:** use a read descriptor for the common patterns. Behaviour names are enums the
package exports (`import { Connection, ListRead, RedirectWhen, SortOrder } from "fast-gql-cache-rs"`):

| Your `read` function | Read descriptor |
| --- | --- |
| `read(existing = value)` | `{ default: value }` |
| `toReference({ __typename, id: args.id })`, a cache redirect | `{ redirect: { typename, keyArgs: { id: "id" } } }` |
| `existing ?? toReference(…)` | the same, with `when: RedirectWhen.missing` |
| one page out of an offset-merged list | `{ list: ListRead.slice, offsetArg?, limitArg? }` |
| a list sorted by a field of its items | `{ list: ListRead.sort, by, order?: SortOrder }` |
| the read half of `relayStylePagination()` | `{ connection: Connection.relay }` |

For anything else:

- **computed fields** (`fullName` from `firstName` and `lastName`): an `@client` field with a
  `LocalState` resolver, which receives the parent object, or a selector in the component;
- **local-only `@client` fields** that a `read` function resolved: a `LocalState` resolver;
- **value transforms** (`new Date(existing)`, `toLowerCase()`): parse in a link or in the
  component.

If yours is a read pattern other applications share and no descriptor covers it yet,
[request a descriptor](https://github.com/convict-git/fast-gql-cache-rs/issues/new?template=descriptor-request.yml).

<details>
<summary>Why</summary>

A `read` function runs inside the cache's memoized read, and anything it touches (store
fields, reactive variables) becomes a dependency of that read without being declared
([ADR 0001, F14](adr/0001-js-rust-wasm-boundary.md#established-facts)). While user
functions can run there, the reader, its memo and the dependency graph have to stay in
JavaScript, and only the store and the write can move to Rust. That was ADR 0001's design.

With no user code inside a read, the reader, the result memo and invalidation all move into
Rust (ADR 0004, [contract 8](adr/0004-declarative-policies-rust-engine.md#4-the-contracts)).
That is where most of the cost of a write-heavy application sits, not in the write itself.
At 5 000 entities, Apollo takes 19.53 ms to re-read after one field changes, 95.99 ms to
broadcast to 200 watchers of one document, and 7.42 s when those watchers use separately
parsed documents ([Apollo performance Part 1](research/performance/01-cost-model.md),
[§4.5](research/performance/04-dependency-graph-and-broadcast.md#45-memo-fragmentation-by-document-identity)).

Supporting functions on a slower path was considered and rejected: one `read` function
anywhere would keep the whole reader in JavaScript for that application
([ADR 0004, considered options](adr/0004-declarative-policies-rust-engine.md#considered-options)).
Each descriptor reproduces the Apollo helper or idiom it replaces and ships with the Apollo
tests for that idiom, so the descriptors lose no semantics.

</details>

#### U2. `merge` functions

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)), checked from its step 2

**Unsupported:** a `merge` function in a field policy or a type policy. `merge: true` and
`merge: false` stay supported.

**You will notice:** construction and `addTypePolicies()` throw, naming each path
(`typePolicies.Query.fields.feed.merge`).

**Instead:** use a merge descriptor. Behaviour names are enums the package exports
(`import { Connection, Dedupe, Keep, ListMerge } from "fast-gql-cache-rs"`):

| Your `merge` function | Merge descriptor |
| --- | --- |
| `concatPagination()`, `[...existing, ...incoming]` | `{ list: ListMerge.append }` |
| `[...incoming, ...existing]` (newest first) | `{ list: ListMerge.prepend }` |
| append only references not already present | `{ list: ListMerge.append, dedupe: Dedupe.ref }` |
| append only items whose key is new | `{ list: ListMerge.append, dedupe: { by: keySpecifier } }` |
| `offsetLimitPagination()` | `{ list: ListMerge.offset, offsetArg? }` |
| a list inside a wrapper object (`{ ...incoming, items: [...] }`) | any list descriptor, plus `path: "items"` |
| `relayStylePagination()` | `{ connection: Connection.relay }` on both `read` and `merge` |
| first write wins, `existing ?? incoming` | `{ keep: Keep.existing }` |
| keep the stored value while a version field is unchanged | `{ keepExistingWhen: { equal: [fieldNames] } }` |

For anything else, such as unit conversion, case normalization or summing numbers,
normalize the data in a link or on the server, or keep that state outside the cache. If
yours is a merge pattern other applications share and no descriptor covers it yet,
[request a descriptor](https://github.com/convict-git/fast-gql-cache-rs/issues/new?template=descriptor-request.yml).

<details>
<summary>Why</summary>

A `merge` function runs in the middle of a write. It can read the cache, it must see
exactly the entities merged before it, and it can throw halfway through
([ADR 0001, F6, F12, F15](adr/0001-js-rust-wasm-boundary.md#established-facts)). To call
one from a Rust write engine, the engine has to stop at every call, hand its invalidations
to JavaScript, let the function run, and resume, in exactly Apollo's order
([ADR 0001, contracts 4–6](adr/0001-js-rust-wasm-boundary.md#the-contracts)). That machinery,
and a boundary crossing at every call, is what keeps a write from being one call into Rust.

Without functions, a write crosses as one buffer and runs to completion
([ADR 0004, contracts 2 and 4](adr/0004-declarative-policies-rust-engine.md#4-the-contracts)).
Apollo takes 83.41 ms for a cold write of 5 000 entities and 75.95 ms to rewrite an
identical payload, with no fast path for "nothing changed"
([Apollo performance Part 1](research/performance/01-cost-model.md)).

</details>

#### U3. `keyFields` and `keyArgs` functions

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)), checked from its step 2

**Unsupported:** a function as `keyFields` on a type policy, or as `keyArgs` on a field
policy.

**You will notice:** construction and `addTypePolicies()` throw, naming each path.

**Instead:** a key specifier array or `false`, as Apollo accepts them:
`keyFields: ["isbn"]`, `keyFields: ["author", ["name"]]`, `keyArgs: ["type", "filter",
["status"]]`. `keyArgs` specifiers can also name `@directive` arguments and `$variables`.

<details>
<summary>Why</summary>

Key functions are policy code that Apollo runs for every entity it identifies
(`keyFields`) and every field key it builds (`keyArgs`), inside writes and reads. The design
rests on no policy code running inside a read or a write, which is what lets the reader move
into Rust (U1, U2). Specifiers are data the cache compiles once: the encoder evaluates the
compiled `keyFields` while it walks a result, and field keys are bound when a document is
first used with a set of variables, so a read in Rust never stops to ask JavaScript for a
key ([ADR 0004, contract 5](adr/0004-declarative-policies-rust-engine.md#4-the-contracts)).

</details>

#### U4. `dataIdFromObject`

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)), checked from its step 2

**Unsupported:** the `dataIdFromObject` option, with any value.

**You will notice:** construction throws. The option is not in `InMemoryCacheRsConfig`.

**Instead:** the default is built in: `__typename:id`, falling back to `__typename:_id`, as
Apollo's `defaultDataIdFromObject`. For types with another key, set `keyFields` on their
type policy. A type whose objects should stay embedded gets `keyFields: false`.

<details>
<summary>Why</summary>

`dataIdFromObject` is a key function for every type without its own `keyFields`: Apollo
calls it for each object written
(`apollo-client-sm/src/cache/inmemory/policies.ts:463`). It has the cost of a `keyFields`
function (U3) on every type at once. The maintainer confirmed its rejection in ADR 0004's
[review](adr/0004-declarative-policies-rust-engine.md#maintainer-decisions).

</details>

#### U5. Reactive variables read by the cache

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#compatibility-amends-adr-0002)), checked from its step 2

**Unsupported:** a query field whose value comes from a reactive variable through a `read`
function (`isInCart() { return cartItemsVar().includes(…) }`), so that queries update when
the variable changes.

**Still supported:** `makeVar`, `cache.makeVar`, and `useReactiveVar` in components.

**You will notice:** the `read` function is rejected (U1).

**Instead:** read the variable with `useReactiveVar` in the component, or write the state into
the cache with `writeQuery` and select it with `@client`.

<details>
<summary>Why</summary>

The cache can only read a reactive variable from inside a `read` function, where the read
is registered as a dependency without being declared
([Apollo architecture §6.6](research/architecture/06-reactivity.md#66-reactive-variables);
[ADR 0001, F14](adr/0001-js-rust-wasm-boundary.md#established-facts)). With `read` functions
gone (U1), no read can depend on a variable. The variable itself does not depend on the
cache, so it keeps working in components.

</details>

#### U6. Fuzzy `possibleTypes`

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)), checked from its step 2

**Unsupported:** a `possibleTypes` entry that is a pattern rather than a type name, which
Apollo turns into a `RegExp`
([Apollo architecture §3.6](research/architecture/03-policies.md#36-fragmentmatches--type-condition-resolution)).

**You will notice:** construction and `cache.policies.addPossibleTypes()` throw, naming each
entry.

**Instead:** list every subtype by name. Generate the map from your schema rather than
writing it by hand.

<details>
<summary>Why</summary>

Apollo compiles any `possibleTypes` entry that is not a plain type name into a `RegExp`,
under a `TODO` saying it should not
(`apollo-client-sm/src/cache/inmemory/policies.ts:633-636`). It consults the patterns only
while writing, when the result's shape suggests that a fragment matches; it prints a
development warning when it infers a subtype; and it cannot remember a negative answer, so
it tests every pattern again on each non-matching check (`:770-800`). The answer also
depends on the order of `addPossibleTypes` calls and of first use. Reproducing that
heuristic exactly costs more than a feature Apollo does not document is worth, so the
maintainer rejected it
([ADR 0004, review](adr/0004-declarative-policies-rust-engine.md#maintainer-decisions)).
A list of names gives the same answers without the heuristic.

</details>

#### U7. `resultCaching: false`

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)), checked from its step 2

**Unsupported:** turning result caching off. Result caching is always on.

**You will notice:** `resultCaching: false` throws at construction. `resultCaching: true` is
accepted and does nothing, so configurations that spell out the default keep working.

**Instead:** remove the option.

<details>
<summary>Why</summary>

In Apollo it is a debugging tool. It makes a warm read about 9 600 times slower in exchange
for a write about 14 % cheaper
([Apollo performance §3.1](research/performance/03-read-path.md#31-the-memo-graph-is-the-read-path)).
Supporting it would mean a second read path with no memo and no dependency index, a second
rule for when the store keeps a deleted field as `undefined`, and a broadcast that
recomputes every watch: complexity in the Rust engine for a mode that should not ship.

</details>

#### U8. Written values that are not plain data

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#1-the-declarative-profile)); documented, never checked

**Unsupported:** values written into the cache that run code when they are read or compared:
objects with getters, Proxies, objects with a custom `valueOf` or `toString`, and class
instances other than `Date`. This covers every write: network results, `writeQuery`,
`writeFragment`, and values returned from modifiers.

**Supported:** JSON values and plain `Date`s.

**You will notice:** nothing warns you, because the cache does not check. Such a value may run
its code while the cache compares it with the stored value. If that code throws, the whole
write is discarded. If it calls a cache method that writes, that call throws.

**Instead:** convert such values to JSON data, or to `Date`s, before they reach the cache,
for example in a link.

<details>
<summary>Why</summary>

The store lives in Rust, but values without a selection set (JSON blobs, custom scalars)
stay JavaScript objects. When a write replaces one, Rust stages the write, JavaScript
compares the old and new values with `@wry/equality`, and Rust commits
([ADR 0004, contract 2](adr/0004-declarative-policies-rust-engine.md#4-the-contracts)). That
comparison calls the values' getters, `valueOf` and iterators, in the middle of a write.
Apollo runs the same code at the same step, but its write is plain JavaScript. Here a write
is staged in Rust, so code running inside it must not change the cache, and a throw has to
cancel the whole write. Checking the values up front is not possible either: inspecting a
Proxy runs its traps. The maintainer decided that such values are unsupported, not
callbacks that the cache must support
([ADR 0004, review](adr/0004-declarative-policies-rust-engine.md#maintainer-decisions)).

</details>

### Runtime environment

#### U9. Runtimes without WebAssembly

**Status:** Decided ([ADR 0003](adr/0003-wasm-initialization.md))

**Unsupported:** any JavaScript runtime without the `WebAssembly` API. Such runtimes have
not been surveyed yet.

**You will notice:** the cache cannot be created.

**Instead:** keep `InMemoryCache` in that runtime.

<details>
<summary>Why</summary>

The cache's engine is WebAssembly, and there is no JavaScript fallback. Rust-WASM is a
product constraint, so no JavaScript engine is built
([ADR 0004, considered options](adr/0004-declarative-policies-rust-engine.md#considered-options)).
A fallback to Apollo's own cache would be `InMemoryCache` itself, which such runtimes can
keep using directly.

</details>

#### U10. Browsers that refuse synchronous WebAssembly compilation

**Status:** Decided ([ADR 0003](adr/0003-wasm-initialization.md))

**Unsupported:** creating the cache on the main thread of Chrome and Chromium-based
browsers before version 115. Other browsers have not been checked yet.

**You will notice:** the first `new InMemoryCacheRs()` on the main thread throws.

**Instead:** keep `InMemoryCache` for those browsers.

<details>
<summary>Why</summary>

`new InMemoryCacheRs()` is synchronous and needs no setup step, like `new InMemoryCache()`,
so it compiles the WebAssembly synchronously on first use. Chrome refused synchronous
main-thread compilation of modules over 4 KB until Chrome 115, which raised the limit to
8 MB. An asynchronous initializer would support those browsers, but it would change how
every application sets up its cache, so none is shipped for now. If one is ever needed, it
will be a static method on `InMemoryCacheRs` (ADR 0003).

</details>

#### U11. Content Security Policies without `'wasm-unsafe-eval'`

**Status:** Decided ([ADR 0003](adr/0003-wasm-initialization.md)); not yet verified in a
browser

**Unsupported:** pages whose Content Security Policy does not allow WebAssembly
compilation.

**You will notice:** the browser refuses to compile the module, and the first
`new InMemoryCacheRs()` throws.

**Instead:** add `'wasm-unsafe-eval'` to the page's `script-src`.

<details>
<summary>Why</summary>

The package ships its WebAssembly inside its JavaScript and compiles it when the first cache
is created. A browser that enforces a Content Security Policy compiles WebAssembly only if
the policy allows it, however the module is loaded (ADR 0003, consequences).

</details>

### Integration

#### U12. `instanceof InMemoryCache`

**Status:** Decided ([ADR 0002](adr/0002-compatibility-target.md)); true of every version

**Unsupported:** `cache instanceof InMemoryCache` is `false` for an `InMemoryCacheRs`.

**You will notice:** code that branches on it takes its other branch.

**Instead:** check `cache instanceof ApolloCache`, and use only the `ApolloCache` API.

<details>
<summary>Why</summary>

`InMemoryCacheRs` extends `ApolloCache`, not `InMemoryCache` (`src/InMemoryCacheRs.ts`).
Extending `InMemoryCache` would inherit its implementation, which is what this package
replaces. Apollo Client never checks for `InMemoryCache`: it uses the cache only through
`ApolloCache` (ADR 0002).

</details>

#### U13. `InMemoryCache` internals

**Status:** Decided ([ADR 0002](adr/0002-compatibility-target.md), tier 3)

**Unsupported:** private and internal members of `InMemoryCache`, such as `cache["data"]`,
`cache["optimisticData"]`, `storeReader`, `storeWriter` and `watches`. Some of them exist
today, but they can change or disappear in any release.

**You will notice:** code that reaches into them breaks, or reads something different, after
an upgrade.

**Instead:** the public `ApolloCache` API: `extract()`, `readQuery()`, `identify()`,
`modify()`, `watch()`.

<details>
<summary>Why</summary>

The store moves into Rust. What JavaScript holds there is no longer the store, so
`InMemoryCache`'s internal objects have nothing to point at
([ADR 0004, step 4](adr/0004-declarative-policies-rust-engine.md#migration-order-and-gates)
removes them). Apollo Client itself never reads them (ADR 0002).

</details>

#### U14. `cache.policies` beyond four methods

**Status:** Decided ([ADR 0004](adr/0004-declarative-policies-rust-engine.md#maintainer-decisions)), from its step 4

**Still supported:** `cache.policies.addTypePolicies()` and `addPossibleTypes()`, validated
as the constructor validates (U1–U7); `identify()`, with Apollo's signature and its
`[id, keyObject]` result; and `fragmentMatches(fragment, typename)`.

**Unsupported:** every other member of Apollo's `Policies`: `readField`, `getStoreFieldName`,
`hasKeyArgs`, `getReadFunction`, `getMergeFunction`, `runMergeFunction`,
`rootIdsByTypename`, `rootTypenamesById`, `usingPossibleTypes` and `cache`. Also the
`result` and `variables` arguments of `fragmentMatches`, which are ignored. `cache.policies`
is not an instance of Apollo's `Policies` class.

**You will notice:** those members are `undefined`, and TypeScript reports them at compile
time.

**Instead:**

| You call | Use |
| --- | --- |
| `cache.policies.readField(…)` | the `readField` that `modify` passes to each modifier |
| `cache.policies.getStoreFieldName(…)` | `cache.evict({ id, fieldName, args })` and `cache.modify()`, which build field keys themselves |
| `cache.policies.rootIdsByTypename` and the other root maps | `"ROOT_QUERY"`, `"ROOT_MUTATION"` and `"ROOT_SUBSCRIPTION"` |

<details>
<summary>Why</summary>

`cache.policies` is not part of the `ApolloCache` interface, and Apollo Client never reads
it (`apollo-client-sm/src/`, outside `cache/inmemory/` and tests). Apollo documents only
`addTypePolicies`, for type policies that code-split modules add after the cache exists
(`docs/source/caching/cache-configuration.mdx`); `addPossibleTypes` serves the same purpose
(`cache/inmemory/inMemoryCache.ts:66-68`). `identify` and `fragmentMatches` stay because
they cost nothing and spare a rename.

The other members are public because Apollo's own reader, writer and store call them
across classes (`readFromStore.ts`, `writeToStore.ts`, `entityStore.ts`). They need
Apollo's internal read and write context to mean anything, and three of them exist only to find and run
`read` and `merge` functions (U1, U2). Step 4 of ADR 0004 removes Apollo's `Policies`
together with those classes. `fragmentMatches`' `result` and `variables` arguments only
feed the fuzzy matching that U6 removes (`cache/inmemory/policies.ts:770-800`).

</details>

### Supported again

None.

## Behaviour drift

Every behaviour in which `InMemoryCacheRs` deliberately differs from `InMemoryCache`. Only
tier-3 behaviours of [ADR 0002](adr/0002-compatibility-target.md) drift, one entry at a
time, each with a measured reason, a migration note and the tests that pin the new
behaviour, all in the same PR.

### Adopted

None. `InMemoryCacheRs` currently matches `InMemoryCache` everywhere the test suite and
the behaviour probe look.

### Decided, registered when implemented

[ADR 0004](adr/0004-declarative-policies-rust-engine.md) decides these drifts. Each moves
to **Adopted**, with its pinning test, in the PR that implements it.

| Behaviour in `InMemoryCache` | In `InMemoryCacheRs` | Why | Migration |
| --- | --- | --- | --- |
| A write that throws while comparing stored values (a getter, or `equal()` overflowing on a JSON blob nested ~10 000 levels) has already committed the entities before it, in production builds | nothing from the write is committed; the original value is rethrown and watches still broadcast | the comparison runs in JS between Rust's staging and commit (ADR 0004 contract 2) | none needed for passive data; do not rely on partial writes |
| Stored lists, references and embedded objects handed to `modify` are frozen in development only; mutating one in production changes the store silently | frozen in every build, so mutating one throws; leaf values the application wrote (JSON blobs, `Date`s) are never frozen | the store lives in Rust; a mutated JS copy would disagree with it (ADR 0004 section 5) | return a new value from the modifier instead of mutating the one received |

### Candidates

Tier-3 behaviours known to be expensive or awkward to reproduce in the Rust core. Listing
one here adopts nothing; each needs its own PR under the
[rules for behaviour drift](#rules-for-behaviour-drift).

| Behaviour today | Possible drift | Why it might pay | Evidence |
| --- | --- | --- | --- |
| An optimistic layer snapshots the whole entity it writes, so a later root write to a field the layer never wrote stays invisible to optimistic reads | per-field overlay: layers hold only the fields they wrote | simpler, smaller layers; arguably the more expected result | ADR 0001 F9, E2 |
| Rewriting `NaN` dirties the field every time (reconciled by `@wry/equality`, dirtied by `!==`) | treat an equal `NaN` as unchanged | one comparison rule instead of two | ADR 0001 F10, E4 |
| With `resultCaching: false`, the Root keeps a deleted field as an own `undefined` | always delete it (moot under ADR 0004, which makes `resultCaching: false` unsupported) | one cleanup rule for both modes | ADR 0001 F9, E3 |
| Development warnings are compared byte for byte, including their order relative to user output | keep each warning's condition, but allow different wording or order | frees the write engine from reproducing console interleaving | `docs/probes/parity.mjs` |
| `extract()` object key order follows insertion into JS objects | any stable order | lets Rust keep its own map order | ADR 0002, tier 3 |

## Maintaining this document

Update it in the same PR that decides, enforces or reverses an entry, as soon as the
decision is made, so that it is never behind the code.

### Rules for unsupported features

- **Scope.** A feature belongs in [Unsupported features](#unsupported-features) when
  `InMemoryCacheRs` rejects it, ignores it or cannot provide it. A feature that works but
  behaves differently belongs in [Behaviour drift](#behaviour-drift). Nothing in tier 1
  of [ADR 0002](adr/0002-compatibility-target.md) can be unsupported, and an unsupported
  tier-2 feature needs the maintainer's approval in an ADR.
- **An entry** has a status with its source, what is unsupported, how an application
  notices, and what to do instead. Keep reasons out of those lines. They go in the
  **Why** block, with the evidence: an ADR, probe numbers, or source paths in
  `apollo-client-sm/src/`.
- **Status.** An entry starts as Proposed or Decided, following its ADR. It becomes Enforced
  in the PR that makes a release reject the feature, naming that version.
- **Numbers are permanent** once merged to `main`. A number is never reused. An entry that
  becomes supported again moves to [Supported again](#supported-again), with the version
  and a link to the change.
- **Keep the summary table in step** with the entries.

### Rules for behaviour drift

- **The rules for a drift** are [ADR 0002's](adr/0002-compatibility-target.md#rules-for-a-drift):
  tier 3 only; a measured gain, or real complexity removed from the Rust core; and an
  entry in the same PR with the old and new behaviour, the reason, a migration note, and
  the tests and probe lines that pin it.
- **Decided** entries move to **Adopted**, with their pinning test, in the PR that
  implements them.
- **Candidates** adopt nothing. Each needs its own PR under these rules.
