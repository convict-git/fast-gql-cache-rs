/**
 * Executable behaviour probe for Apollo Client's `InMemoryCache` (v4.2.11).
 *
 * Every claim made in `docs/apollo-client-inmemory-cache.md` that is
 * observable from the public API is exercised here, so the documentation can
 * be re-validated against a new Apollo version by re-running this file:
 *
 *   node --conditions=development docs/probes/cache-behavior-probe.mjs
 *
 * `--conditions=development` is required: without it Node resolves the
 * production build of `@apollo/client`, where `__DEV__` is `false` and the
 * result-freezing / data-loss-warning behaviour is compiled out.
 *
 * It is also the reference-behaviour oracle for the Rust-WASM port: any
 * `InMemoryCacheRs` implementation must reproduce this output verbatim.
 */
import assert from "node:assert/strict";

import { InMemoryCache, makeVar } from "@apollo/client/cache";
import { gql } from "graphql-tag";

let sectionNo = 0;
const failures = [];

function section(title) {
  console.log(`\n${"=".repeat(78)}\n${++sectionNo}. ${title}\n${"=".repeat(78)}`);
}

function show(label, value) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2));
}

function check(label, fn) {
  try {
    fn();
    console.log(`  [PASS] ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  [FAIL] ${label}\n         ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
section("Normalization: split -> identify -> flatten (blog's GetAllTodos)");
// ---------------------------------------------------------------------------
{
  const GET_ALL_TODOS = gql`
    query GetAllTodos {
      todos {
        id
        text
        completed
      }
    }
  `;

  const cache = new InMemoryCache();
  cache.writeQuery({
    query: GET_ALL_TODOS,
    data: {
      todos: [
        { __typename: "Todo", id: 1, text: "First todo", completed: true },
        { __typename: "Todo", id: 2, text: "Second todo", completed: false },
        { __typename: "Todo", id: 3, text: "Third todo", completed: false },
      ],
    },
  });

  show("cache.extract() after GetAllTodos", cache.extract());

  check("ROOT_QUERY holds an ordered list of References, not embedded objects", () => {
    const store = cache.extract();
    assert.deepEqual(store.ROOT_QUERY.todos, [
      { __ref: "Todo:1" },
      { __ref: "Todo:2" },
      { __ref: "Todo:3" },
    ]);
  });

  check("each Todo is a flat top-level entry keyed by `__typename:id`", () => {
    const store = cache.extract();
    assert.deepEqual(store["Todo:3"], {
      __typename: "Todo",
      id: 3,
      text: "Third todo",
      completed: false,
    });
  });

  // The blog's EditTodo example: a mutation returning only { id, text, completed }
  // merges field-by-field into the *same* normalized entity.
  const EDIT_TODO = gql`
    mutation EditTodo($id: Int!, $text: String!) {
      editTodo(id: $id, text: $text) {
        todo {
          id
          text
          completed
        }
      }
    }
  `;
  cache.writeQuery({
    query: EDIT_TODO,
    id: "ROOT_MUTATION",
    variables: { id: 3, text: "Best todo" },
    data: {
      editTodo: {
        __typename: "EditTodoResponse",
        todo: {
          __typename: "Todo",
          id: 3,
          text: "Best todo",
          completed: false,
        },
      },
    },
  });

  show("Todo:3 after EditTodo merged in", cache.extract()["Todo:3"]);
  show("ROOT_MUTATION after EditTodo", cache.extract().ROOT_MUTATION);

  check("mutation payload merged into the existing entity (no duplicate)", () => {
    assert.equal(cache.extract()["Todo:3"].text, "Best todo");
  });

  check("ROOT_MUTATION field key embeds canonically-stringified arguments", () => {
    assert.deepEqual(Object.keys(cache.extract().ROOT_MUTATION).sort(), [
      "__typename",
      'editTodo({"id":3,"text":"Best todo"})',
    ]);
  });

  check("the GetAllTodos read still observes the updated Todo:3", () => {
    const result = cache.readQuery({ query: GET_ALL_TODOS });
    assert.equal(result.todos[2].text, "Best todo");
  });
}

// ---------------------------------------------------------------------------
section("Identity: keyFields specifiers, including the blog's nested form");
// ---------------------------------------------------------------------------
{
  const cache = new InMemoryCache({
    typePolicies: {
      Todo: { keyFields: ["date", "user", ["email"]] },
      Book: { keyFields: ["isbn"] },
      Session: { keyFields: false },
      Point: { keyFields: ["x", "y"] },
    },
  });

  const ids = {
    nestedKeyFields: cache.identify({
      __typename: "Todo",
      text: "First todo",
      completed: false,
      date: "2020-07-08T15:05:32.248Z",
      user: { __typename: "User", email: "me@apollographql.com" },
    }),
    singleKeyField: cache.identify({ __typename: "Book", isbn: "1234" }),
    compositeKeyFields: cache.identify({ __typename: "Point", x: 1, y: 2 }),
    defaultId: cache.identify({ __typename: "Author", id: 7 }),
    defaultUnderscoreId: cache.identify({ __typename: "Author", _id: 7 }),
    normalizationDisabled: cache.identify({ __typename: "Session", id: 1 }),
    noTypename: cache.identify({ id: 1 }),
    reference: cache.identify({ __ref: "Todo:1" }),
  };

  show("cache.identify() across key configurations", ids);

  check("nested keyFields produce the exact ID string documented in the blog", () => {
    assert.equal(
      ids.nestedKeyFields,
      'Todo:{"date":"2020-07-08T15:05:32.248Z","user":{"email":"me@apollographql.com"}}'
    );
  });
  check("single scalar keyField is inlined without JSON braces", () => {
    assert.equal(ids.singleKeyField, 'Book:{"isbn":"1234"}');
  });
  check("`keyFields: false` disables normalization (undefined id)", () => {
    assert.equal(ids.normalizationDisabled, undefined);
  });
  check("default dataIdFromObject falls back from `id` to `_id`", () => {
    assert.equal(ids.defaultId, "Author:7");
    assert.equal(ids.defaultUnderscoreId, "Author:7");
  });
  check("a Reference identifies as its own __ref", () => {
    assert.equal(ids.reference, "Todo:1");
  });
  check("keyFields order is canonicalised, not source order", () => {
    const a = cache.identify({ __typename: "Point", x: 1, y: 2 });
    const b = cache.identify({ __typename: "Point", y: 2, x: 1 });
    assert.equal(a, b);
  });
}

// ---------------------------------------------------------------------------
section("Field identity: storeFieldName derivation and keyArgs");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query Feed($type: String!, $limit: Int) {
      feed(type: $type, limit: $limit) {
        id
      }
    }
  `;

  const defaultCache = new InMemoryCache();
  defaultCache.writeQuery({
    query: QUERY,
    variables: { type: "top", limit: 10 },
    data: { feed: [{ __typename: "Post", id: 1 }] },
  });

  const keyArgsCache = new InMemoryCache({
    typePolicies: { Query: { fields: { feed: { keyArgs: ["type"] } } } },
  });
  keyArgsCache.writeQuery({
    query: QUERY,
    variables: { type: "top", limit: 10 },
    data: { feed: [{ __typename: "Post", id: 1 }] },
  });

  const keyArgsFalseCache = new InMemoryCache({
    typePolicies: { Query: { fields: { feed: { keyArgs: false } } } },
  });
  keyArgsFalseCache.writeQuery({
    query: QUERY,
    variables: { type: "top", limit: 10 },
    data: { feed: [{ __typename: "Post", id: 1 }] },
  });

  const CONNECTION = gql`
    query Feed($type: String!, $limit: Int) {
      feed(type: $type, limit: $limit) @connection(key: "feed", filter: ["type"]) {
        id
      }
    }
  `;
  const connectionCache = new InMemoryCache();
  connectionCache.writeQuery({
    query: CONNECTION,
    variables: { type: "top", limit: 10 },
    data: { feed: [{ __typename: "Post", id: 1 }] },
  });

  const keys = {
    default: Object.keys(defaultCache.extract().ROOT_QUERY),
    keyArgsType: Object.keys(keyArgsCache.extract().ROOT_QUERY),
    keyArgsFalse: Object.keys(keyArgsFalseCache.extract().ROOT_QUERY),
    connectionDirective: Object.keys(connectionCache.extract().ROOT_QUERY),
  };
  show("ROOT_QUERY field keys per keyArgs configuration", keys);

  check("default keyArgs serialises every argument, sorted", () => {
    assert.ok(keys.default.includes('feed({"limit":10,"type":"top"})'));
  });
  check("keyArgs: ['type'] narrows the key to the selected argument", () => {
    assert.ok(keys.keyArgsType.includes('feed:{"type":"top"}'));
  });
  check("keyArgs: false collapses the key to the bare field name", () => {
    assert.ok(keys.keyArgsFalse.includes("feed"));
  });
  check("@connection(key, filter) overrides the generated key", () => {
    assert.ok(keys.connectionDirective.includes('feed({"type":"top"})'));
  });

  // Argument-key canonicalisation: key order in variables must not matter.
  const NESTED = gql`
    query Search($where: JSON) {
      search(where: $where) {
        id
      }
    }
  `;
  const c1 = new InMemoryCache();
  c1.writeQuery({
    query: NESTED,
    variables: { where: { b: 2, a: 1 } },
    data: { search: [{ __typename: "Hit", id: 1 }] },
  });
  const c2 = new InMemoryCache();
  c2.writeQuery({
    query: NESTED,
    variables: { where: { a: 1, b: 2 } },
    data: { search: [{ __typename: "Hit", id: 1 }] },
  });
  show("argument canonicalisation", {
    unsortedInput: Object.keys(c1.extract().ROOT_QUERY),
    sortedInput: Object.keys(c2.extract().ROOT_QUERY),
  });
  check("canonicalStringify sorts nested argument keys so both writes collide", () => {
    assert.deepEqual(
      Object.keys(c1.extract().ROOT_QUERY),
      Object.keys(c2.extract().ROOT_QUERY)
    );
  });
}

// ---------------------------------------------------------------------------
section("Result caching: referential identity and its invalidation domain");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query {
      a {
        id
        name
      }
      b {
        id
        name
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: QUERY,
    data: {
      a: { __typename: "A", id: 1, name: "a1" },
      b: { __typename: "B", id: 1, name: "b1" },
    },
  });

  const r1 = cache.readQuery({ query: QUERY });
  const r2 = cache.readQuery({ query: QUERY });

  check("repeated reads of unchanged data return the identical object", () => {
    assert.equal(r1, r2);
  });

  // Writing a value that is deeply equal to what is already stored must not
  // dirty anything: storeObjectReconciler keeps the existing reference.
  cache.writeQuery({
    query: gql`
      query {
        a {
          id
          name
        }
      }
    `,
    data: { a: { __typename: "A", id: 1, name: "a1" } },
  });
  const r3 = cache.readQuery({ query: QUERY });
  check("writing deeply-equal data preserves referential identity", () => {
    assert.equal(r1, r3);
  });

  // Writing a genuinely new value for B must invalidate the root result but
  // leave the untouched A subtree object identical.
  cache.writeQuery({
    query: gql`
      query {
        b {
          id
          name
        }
      }
    `,
    data: { b: { __typename: "B", id: 1, name: "b2" } },
  });
  const r4 = cache.readQuery({ query: QUERY });
  check("a real change invalidates the enclosing result object", () => {
    assert.notEqual(r1, r4);
  });
  check("unaffected subtrees are structurally shared with the previous read", () => {
    assert.equal(r1.a, r4.a);
  });

  const noCaching = new InMemoryCache({ resultCaching: false });
  noCaching.writeQuery({
    query: QUERY,
    data: {
      a: { __typename: "A", id: 1, name: "a1" },
      b: { __typename: "B", id: 1, name: "b1" },
    },
  });
  check("resultCaching: false gives up identity stability entirely", () => {
    assert.notEqual(
      noCaching.readQuery({ query: QUERY }),
      noCaching.readQuery({ query: QUERY })
    );
  });
}

// ---------------------------------------------------------------------------
section("diff(): completeness, MissingFieldError and returnPartialData");
// ---------------------------------------------------------------------------
{
  const WRITE = gql`
    query {
      me {
        id
        name
      }
    }
  `;
  const READ = gql`
    query {
      me {
        id
        name
        email
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: WRITE,
    data: { me: { __typename: "User", id: 1, name: "Ada" } },
  });

  const diff = cache.diff({ query: READ, optimistic: false, returnPartialData: true });
  show("diff() for a partially-satisfiable query", {
    complete: diff.complete,
    result: diff.result,
    missingMessage: diff.missing?.message,
    missingTree: diff.missing?.missing,
  });

  check("diff reports complete: false when any selected field is absent", () => {
    assert.equal(diff.complete, false);
  });
  check("missing.missing is a tree mirroring the query shape", () => {
    assert.deepEqual(Object.keys(diff.missing.missing), ["me"]);
    assert.deepEqual(Object.keys(diff.missing.missing.me), ["email"]);
  });
  check("partial data still contains everything that was resolvable", () => {
    assert.deepEqual(diff.result, { me: { __typename: "User", id: 1, name: "Ada" } });
  });
  check("read() without returnPartialData collapses a partial result to null", () => {
    assert.equal(cache.read({ query: READ, optimistic: false }), null);
  });
  check("read() with returnPartialData surfaces the partial object", () => {
    assert.deepEqual(
      cache.read({ query: READ, optimistic: false, returnPartialData: true }),
      { me: { __typename: "User", id: 1, name: "Ada" } }
    );
  });

  const dangling = new InMemoryCache();
  dangling.writeQuery({
    query: gql`
      query {
        me {
          id
          name
        }
      }
    `,
    data: { me: { __typename: "User", id: 1, name: "Ada" } },
  });
  dangling.evict({ id: "User:1" });
  const danglingDiff = dangling.diff({
    query: gql`
      query {
        me {
          id
          name
        }
      }
    `,
    optimistic: false,
    returnPartialData: true,
  });
  show("diff() over a dangling reference", {
    complete: danglingDiff.complete,
    missingMessage: danglingDiff.missing?.message,
    rootQuery: dangling.extract().ROOT_QUERY,
  });
  check("evicting a target leaves a dangling ref that reads as missing", () => {
    assert.match(danglingDiff.missing.message, /Dangling reference to missing User:1/);
  });
}

// ---------------------------------------------------------------------------
section("Optimistic layers: stacking, isolation, replay on removal");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query {
      todo {
        id
        text
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: QUERY,
    data: { todo: { __typename: "Todo", id: 1, text: "server" } },
  });

  cache.batch({
    optimistic: "layer-A",
    update(c) {
      c.writeQuery({
        query: QUERY,
        data: { todo: { __typename: "Todo", id: 1, text: "optimistic-A" } },
      });
    },
  });
  cache.batch({
    optimistic: "layer-B",
    update(c) {
      c.modify({
        id: "Todo:1",
        fields: { text: (value) => `${value}+B` },
      });
    },
  });

  show("layered reads", {
    optimisticRead: cache.readQuery({ query: QUERY, optimistic: true }),
    rootRead: cache.readQuery({ query: QUERY, optimistic: false }),
    extractRoot: cache.extract(false)["Todo:1"],
    extractOptimistic: cache.extract(true)["Todo:1"],
  });

  check("optimistic reads see the top of the layer stack", () => {
    assert.equal(cache.readQuery({ query: QUERY, optimistic: true }).todo.text, "optimistic-A+B");
  });
  check("non-optimistic reads are unaffected by any layer", () => {
    assert.equal(cache.readQuery({ query: QUERY, optimistic: false }).todo.text, "server");
  });

  // Removing the *bottom* layer forces the layer above it to be replayed on
  // top of the new parent, which is why `replay` is retained per layer.
  cache.removeOptimistic("layer-A");
  show("after removeOptimistic('layer-A')", {
    optimisticRead: cache.readQuery({ query: QUERY, optimistic: true }),
    rootRead: cache.readQuery({ query: QUERY, optimistic: false }),
  });
  check("removing a lower layer replays the higher layer over the new parent", () => {
    assert.equal(cache.readQuery({ query: QUERY, optimistic: true }).todo.text, "server+B");
  });

  cache.removeOptimistic("layer-B");
  check("removing every layer restores the root value exactly", () => {
    assert.equal(cache.readQuery({ query: QUERY, optimistic: true }).todo.text, "server");
  });
  check("root data was never mutated by optimistic work", () => {
    assert.equal(cache.extract(false)["Todo:1"].text, "server");
  });
}

// ---------------------------------------------------------------------------
section("Broadcast: memoized watch recomputation and the equality gate");
// ---------------------------------------------------------------------------
{
  const WATCHED = gql`
    query {
      watched {
        id
        name
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: WATCHED,
    data: { watched: { __typename: "Watched", id: 1, name: "n1" } },
  });

  const deliveries = [];
  const unwatch = cache.watch({
    query: WATCHED,
    optimistic: false,
    immediate: true,
    callback: (diff) => deliveries.push(diff.result.watched.name),
  });

  // (a) an unrelated entity changes: the watcher must not be notified at all.
  cache.writeQuery({
    query: gql`
      query {
        other {
          id
          name
        }
      }
    `,
    data: { other: { __typename: "Other", id: 1, name: "o1" } },
  });
  const afterUnrelated = deliveries.length;

  // (b) a no-op write of identical data: dirtied, recomputed, but suppressed
  //     by the `equal(lastDiff.result, diff.result)` gate in broadcastWatch.
  cache.writeQuery({
    query: WATCHED,
    data: { watched: { __typename: "Watched", id: 1, name: "n1" } },
  });
  const afterNoop = deliveries.length;

  // (c) a real change: delivered.
  cache.writeQuery({
    query: WATCHED,
    data: { watched: { __typename: "Watched", id: 1, name: "n2" } },
  });
  const afterRealChange = deliveries.length;

  show("watch deliveries", {
    deliveries,
    afterImmediate: 1,
    afterUnrelated,
    afterNoop,
    afterRealChange,
  });

  check("immediate: true delivers an initial diff synchronously", () => {
    assert.deepEqual(deliveries[0], "n1");
  });
  check("an unrelated write does not notify the watcher", () => {
    assert.equal(afterUnrelated, 1);
  });
  check("a value-preserving write is suppressed by the equality gate", () => {
    assert.equal(afterNoop, 1);
  });
  check("a value-changing write is delivered exactly once", () => {
    assert.equal(afterRealChange, 2);
    assert.deepEqual(deliveries, ["n1", "n2"]);
  });

  // Batching: N writes inside one batch produce at most one broadcast.
  const before = deliveries.length;
  cache.batch({
    optimistic: false,
    update(c) {
      c.writeQuery({
        query: WATCHED,
        data: { watched: { __typename: "Watched", id: 1, name: "n3" } },
      });
      c.writeQuery({
        query: WATCHED,
        data: { watched: { __typename: "Watched", id: 1, name: "n4" } },
      });
    },
  });
  show("batched writes", { deliveriesAdded: deliveries.length - before, deliveries });
  check("cache.batch collapses multiple writes into one broadcast", () => {
    assert.equal(deliveries.length - before, 1);
  });

  unwatch();
  cache.writeQuery({
    query: WATCHED,
    data: { watched: { __typename: "Watched", id: 1, name: "n5" } },
  });
  check("the unsubscribe function stops all further deliveries", () => {
    assert.equal(deliveries[deliveries.length - 1], "n4");
  });
}

// ---------------------------------------------------------------------------
section("modify(): DELETE, INVALIDATE and the readField helper");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query {
      todo {
        id
        text
        completed
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: QUERY,
    data: { todo: { __typename: "Todo", id: 1, text: "t", completed: false } },
  });

  const modified = cache.modify({
    id: "Todo:1",
    fields: {
      completed: (value) => !value,
      text: (value, { DELETE }) => (value === "t" ? DELETE : value),
    },
  });
  show("after modify with a toggle and a DELETE", {
    returned: modified,
    entity: cache.extract()["Todo:1"],
  });
  check("modify returns true when at least one field changed", () => {
    assert.equal(modified, true);
  });
  check("DELETE removes the field from the root-layer StoreObject", () => {
    assert.deepEqual(cache.extract()["Todo:1"], {
      __typename: "Todo",
      id: 1,
      completed: true,
    });
  });

  const noop = cache.modify({ id: "Todo:1", fields: { completed: (v) => v } });
  check("modify returns false when every modifier is an identity function", () => {
    assert.equal(noop, false);
  });

  const missing = cache.modify({ id: "Todo:404", fields: { text: () => "x" } });
  check("modify on an unknown id returns false without creating an entity", () => {
    assert.equal(missing, false);
    assert.equal(cache.extract()["Todo:404"], undefined);
  });

  const falsyId = cache.modify({ id: undefined, fields: { text: () => "x" } });
  check("an explicitly falsy `id` returns false instead of hitting ROOT_QUERY", () => {
    assert.equal(falsyId, false);
  });

  // INVALIDATE dirties the dependency without changing the stored value, so a
  // watcher recomputes but the equality gate still suppresses the delivery.
  const deliveries = [];
  const unwatch = cache.watch({
    query: gql`
      query {
        todo {
          id
          completed
        }
      }
    `,
    optimistic: false,
    immediate: true,
    callback: (diff) => deliveries.push(diff.result),
  });
  const invalidated = cache.modify({
    id: "Todo:1",
    fields: { completed: (_v, { INVALIDATE }) => INVALIDATE },
  });
  show("after INVALIDATE", {
    returned: invalidated,
    deliveries: deliveries.length,
    entity: cache.extract()["Todo:1"],
  });
  check("INVALIDATE leaves the stored value untouched and returns false", () => {
    assert.equal(invalidated, false);
    assert.equal(cache.extract()["Todo:1"].completed, true);
  });
  unwatch();
}

// ---------------------------------------------------------------------------
section("Garbage collection: reachability, retain/release, __META");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query {
      author {
        id
        name
        books {
          id
          title
        }
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: QUERY,
    data: {
      author: {
        __typename: "Author",
        id: 1,
        name: "Ada",
        books: [
          { __typename: "Book", id: 1, title: "b1" },
          { __typename: "Book", id: 2, title: "b2" },
        ],
      },
    },
  });

  show("store before gc", Object.keys(cache.extract()));
  check("gc() collects nothing while everything is reachable from ROOT_QUERY", () => {
    assert.deepEqual(cache.gc(), []);
  });

  // Detach Book:2 from the only path that reaches it.
  cache.modify({
    id: "Author:1",
    fields: {
      books: (existing, { readField }) =>
        existing.filter((ref) => readField("id", ref) !== 2),
    },
  });
  const collected = cache.gc();
  show("after detaching Book:2", {
    collected,
    remaining: Object.keys(cache.extract()),
  });
  check("gc() collects entities that became unreachable", () => {
    assert.deepEqual(collected, ["Book:2"]);
  });

  // retain() pins an entity as an extra GC root and survives extract/restore.
  cache.writeFragment({
    id: "Book:3",
    fragment: gql`
      fragment B on Book {
        id
        title
      }
    `,
    data: { __typename: "Book", id: 3, title: "b3" },
  });
  const snapshot = cache.extract();
  show("__META after a direct writeFragment", snapshot.__META);
  check("directly-written entities are auto-retained and recorded in __META", () => {
    assert.deepEqual(snapshot.__META, { extraRootIds: ["Book:3"] });
  });
  check("an auto-retained entity survives gc()", () => {
    assert.deepEqual(cache.gc(), []);
    assert.ok(cache.extract()["Book:3"]);
  });

  const restored = new InMemoryCache().restore(snapshot);
  check("restore() reinstates extraRootIds so retention survives serialization", () => {
    assert.deepEqual(restored.gc(), []);
    assert.ok(restored.extract()["Book:3"]);
  });

  check("release() drops the retainment and makes the entity collectable", () => {
    assert.equal(cache.release("Book:3"), 0);
    assert.deepEqual(cache.gc(), ["Book:3"]);
  });
  check("retain() is a counter, not a flag", () => {
    assert.equal(cache.retain("Book:9"), 1);
    assert.equal(cache.retain("Book:9"), 2);
    assert.equal(cache.release("Book:9"), 1);
    assert.equal(cache.release("Book:9"), 0);
    assert.equal(cache.release("Book:9"), 0);
  });
}

// ---------------------------------------------------------------------------
section("Merge functions: field policy, type policy, mergeObjects, overwrite");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query Feed($offset: Int) {
      feed(offset: $offset) {
        id
      }
    }
  `;
  const paginated = new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          feed: {
            keyArgs: false,
            merge(existing = [], incoming) {
              return [...existing, ...incoming];
            },
          },
        },
      },
    },
  });
  paginated.writeQuery({
    query: QUERY,
    variables: { offset: 0 },
    data: { feed: [{ __typename: "Post", id: 1 }] },
  });
  paginated.writeQuery({
    query: QUERY,
    variables: { offset: 1 },
    data: { feed: [{ __typename: "Post", id: 2 }] },
  });
  show("paginated ROOT_QUERY", paginated.extract().ROOT_QUERY);
  check("a field merge function accumulates across writes under one key", () => {
    assert.deepEqual(paginated.extract().ROOT_QUERY.feed, [
      { __ref: "Post:1" },
      { __ref: "Post:2" },
    ]);
  });

  // Non-normalized child objects clobber by default; merge:true fixes it.
  const CHILD = gql`
    query {
      me {
        id
        prefs {
          theme
          locale
        }
      }
    }
  `;
  const clobbering = new InMemoryCache();
  clobbering.writeQuery({
    query: gql`
      query {
        me {
          id
          prefs {
            theme
          }
        }
      }
    `,
    data: { me: { __typename: "User", id: 1, prefs: { __typename: "Prefs", theme: "dark" } } },
  });
  clobbering.writeQuery({
    query: gql`
      query {
        me {
          id
          prefs {
            locale
          }
        }
      }
    `,
    data: { me: { __typename: "User", id: 1, prefs: { __typename: "Prefs", locale: "en" } } },
  });

  const merging = new InMemoryCache({ typePolicies: { Prefs: { merge: true } } });
  merging.writeQuery({
    query: gql`
      query {
        me {
          id
          prefs {
            theme
          }
        }
      }
    `,
    data: { me: { __typename: "User", id: 1, prefs: { __typename: "Prefs", theme: "dark" } } },
  });
  merging.writeQuery({
    query: gql`
      query {
        me {
          id
          prefs {
            locale
          }
        }
      }
    `,
    data: { me: { __typename: "User", id: 1, prefs: { __typename: "Prefs", locale: "en" } } },
  });

  show("non-normalized child merge behaviour", {
    withoutMergePolicy: clobbering.extract()["User:1"].prefs,
    withMergeTrue: merging.extract()["User:1"].prefs,
  });
  check("an un-normalized child object is replaced wholesale by default", () => {
    assert.deepEqual(clobbering.extract()["User:1"].prefs, {
      __typename: "Prefs",
      locale: "en",
    });
  });
  check("`merge: true` on the child type policy preserves both writes", () => {
    assert.deepEqual(merging.extract()["User:1"].prefs, {
      __typename: "Prefs",
      theme: "dark",
      locale: "en",
    });
  });
  check("reading the combined selection is complete only with merge: true", () => {
    assert.equal(clobbering.diff({ query: CHILD, optimistic: false }).complete, false);
    assert.equal(merging.diff({ query: CHILD, optimistic: false }).complete, true);
  });

  // overwrite: true bypasses `existing` inside merge functions.
  paginated.writeQuery({
    query: QUERY,
    variables: { offset: 0 },
    overwrite: true,
    data: { feed: [{ __typename: "Post", id: 3 }] },
  });
  show("after overwrite: true", paginated.extract().ROOT_QUERY.feed);
  check("overwrite: true makes the merge function see `existing === undefined`", () => {
    assert.deepEqual(paginated.extract().ROOT_QUERY.feed, [{ __ref: "Post:3" }]);
  });
}

// ---------------------------------------------------------------------------
section("Read functions, reactive variables and cache redirects");
// ---------------------------------------------------------------------------
{
  const themeVar = makeVar("light");
  const cache = new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          theme: { read: () => themeVar() },
          // Classic cache redirect: satisfy todo(id:) from a normalized entity
          // that was populated by a completely different query.
          todo: {
            read(_existing, { args, toReference }) {
              return toReference({ __typename: "Todo", id: args.id });
            },
          },
        },
      },
    },
  });

  cache.writeQuery({
    query: gql`
      query {
        todos {
          id
          text
        }
      }
    `,
    data: {
      todos: [
        { __typename: "Todo", id: 1, text: "one" },
        { __typename: "Todo", id: 2, text: "two" },
      ],
    },
  });

  const BY_ID = gql`
    query TodoById($id: Int!) {
      todo(id: $id) {
        id
        text
      }
    }
  `;
  const redirected = cache.readQuery({ query: BY_ID, variables: { id: 2 } });
  show("cache redirect result", {
    redirected,
    rootQueryKeys: Object.keys(cache.extract().ROOT_QUERY),
  });
  check("a read function can redirect to an existing normalized entity", () => {
    assert.deepEqual(redirected, { todo: { __typename: "Todo", id: 2, text: "two" } });
  });
  check("the redirect stores nothing new in ROOT_QUERY", () => {
    assert.ok(!Object.keys(cache.extract().ROOT_QUERY).some((k) => k.startsWith("todo(")));
  });

  const THEME = gql`
    query {
      theme
    }
  `;
  const deliveries = [];
  const unwatch = cache.watch({
    query: THEME,
    optimistic: false,
    immediate: true,
    callback: (diff) => deliveries.push(diff.result.theme),
  });
  themeVar("dark");
  show("reactive variable deliveries", deliveries);
  check("writing a reactive variable re-broadcasts dependent watches", () => {
    assert.deepEqual(deliveries, ["light", "dark"]);
  });
  unwatch();
}

// ---------------------------------------------------------------------------
section("fragmentMatches: possibleTypes and interface/union resolution");
// ---------------------------------------------------------------------------
{
  const cache = new InMemoryCache({
    possibleTypes: {
      Character: ["Jedi", "Droid"],
      Jedi: ["PadawanJedi"],
    },
  });

  const fragment = (typeCondition) =>
    gql`
      fragment On${typeCondition} on ${typeCondition} {
        id
      }
    `.definitions[0];

  const matches = {
    exact: cache.fragmentMatches(fragment("Jedi"), "Jedi"),
    directSubtype: cache.fragmentMatches(fragment("Character"), "Droid"),
    transitiveSubtype: cache.fragmentMatches(fragment("Character"), "PadawanJedi"),
    unrelated: cache.fragmentMatches(fragment("Character"), "Starship"),
  };
  show("fragmentMatches results", matches);
  check("an exact typename match short-circuits", () => assert.equal(matches.exact, true));
  check("possibleTypes resolves a direct subtype", () =>
    assert.equal(matches.directSubtype, true));
  check("supertype search is transitive across the possibleTypes graph", () =>
    assert.equal(matches.transitiveSubtype, true));
  check("an unrelated typename does not match", () =>
    assert.equal(matches.unrelated, false));
}

// ---------------------------------------------------------------------------
section("evict(): whole entity, single field, and field-with-args");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query Feed($type: String!) {
      feed(type: $type) {
        id
      }
      other {
        id
      }
    }
  `;
  const cache = new InMemoryCache();
  for (const type of ["top", "new"]) {
    cache.writeQuery({
      query: QUERY,
      variables: { type },
      data: {
        feed: [{ __typename: "Post", id: 1 }],
        other: { __typename: "Other", id: 1 },
      },
    });
  }

  show("ROOT_QUERY before eviction", Object.keys(cache.extract().ROOT_QUERY));

  const evictedWithArgs = cache.evict({
    id: "ROOT_QUERY",
    fieldName: "feed",
    args: { type: "top" },
  });
  show("after evicting feed(type: top)", {
    evicted: evictedWithArgs,
    keys: Object.keys(cache.extract().ROOT_QUERY),
  });
  check("evict with args removes exactly one argument-keyed field", () => {
    const keys = Object.keys(cache.extract().ROOT_QUERY);
    assert.ok(!keys.includes('feed({"type":"top"})'));
    assert.ok(keys.includes('feed({"type":"new"})'));
  });

  cache.evict({ id: "ROOT_QUERY", fieldName: "feed" });
  check("evict without args removes every field sharing the short field name", () => {
    assert.ok(!Object.keys(cache.extract().ROOT_QUERY).some((k) => k.startsWith("feed")));
  });

  const evictedEntity = cache.evict({ id: "Post:1" });
  show("after evicting Post:1", { evicted: evictedEntity, store: cache.extract() });
  check("evicting an entity removes its whole StoreObject", () => {
    assert.equal(evictedEntity, true);
    assert.equal(cache.extract()["Post:1"], undefined);
  });
  check("evicting an absent id returns false", () => {
    assert.equal(cache.evict({ id: "Post:404" }), false);
  });
}

// ---------------------------------------------------------------------------
section("reset() and restore(): lifecycle of watches and result caches");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query {
      me {
        id
        name
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: QUERY,
    data: { me: { __typename: "User", id: 1, name: "Ada" } },
  });

  const deliveries = [];
  cache.watch({
    query: QUERY,
    optimistic: false,
    returnPartialData: true,
    callback: (diff) => deliveries.push(diff.complete),
  });

  await cache.reset();
  show("after reset()", { store: cache.extract(), deliveries });
  check("reset() empties the store", () => {
    assert.deepEqual(cache.extract(), {});
  });
  check("reset() keeps watches and re-broadcasts an incomplete diff", () => {
    assert.deepEqual(deliveries, [false]);
  });

  const snapshot = {
    ROOT_QUERY: { __typename: "Query", me: { __ref: "User:1" } },
    "User:1": { __typename: "User", id: 1, name: "Restored" },
  };
  cache.restore(snapshot);
  show("after restore()", cache.readQuery({ query: QUERY }));
  check("restore() rehydrates a serialized NormalizedCacheObject", () => {
    assert.deepEqual(cache.readQuery({ query: QUERY }), {
      me: { __typename: "User", id: 1, name: "Restored" },
    });
  });

  const discarding = new InMemoryCache();
  let discardedDeliveries = 0;
  discarding.watch({
    query: QUERY,
    optimistic: false,
    returnPartialData: true,
    callback: () => discardedDeliveries++,
  });
  await discarding.reset({ discardWatches: true });
  check("reset({ discardWatches: true }) tears watches down silently", () => {
    assert.equal(discardedDeliveries, 0);
  });
}

// ---------------------------------------------------------------------------
section("Immutability: results are deeply frozen in development builds");
// ---------------------------------------------------------------------------
{
  const QUERY = gql`
    query {
      me {
        id
        tags
      }
    }
  `;
  const cache = new InMemoryCache();
  cache.writeQuery({
    query: QUERY,
    data: { me: { __typename: "User", id: 1, tags: ["a", "b"] } },
  });
  const result = cache.readQuery({ query: QUERY });
  show("frozen-ness of a read result", {
    rootFrozen: Object.isFrozen(result),
    childFrozen: Object.isFrozen(result.me),
    arrayFrozen: Object.isFrozen(result.me.tags),
    assumeImmutableResults: cache.assumeImmutableResults,
  });
  check("InMemoryCache advertises assumeImmutableResults", () => {
    assert.equal(cache.assumeImmutableResults, true);
  });
  check("read results are deeply frozen under __DEV__", () => {
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.me));
    assert.ok(Object.isFrozen(result.me.tags));
  });
  check("the caller's input object is not aliased into the store", () => {
    const input = { me: { __typename: "User", id: 2, tags: ["x"] } };
    cache.writeQuery({ query: QUERY, data: input });
    assert.ok(!Object.isFrozen(input.me.tags));
  });
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(78)}`);
if (failures.length) {
  console.log(`RESULT: ${failures.length} check(s) FAILED`);
  for (const { label, error } of failures) {
    console.log(`  - ${label}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log("RESULT: all checks passed");
}
console.log("=".repeat(78));
