# Part 3 — `Policies`

[Documentation](../README.md) › [Architecture guide](README.md) · [← Part 2](02-normalized-store.md) · [Part 4 →](04-store-writer.md)

`EntityStore` knows how to store things but not *what to call them*. Every naming
decision — which objects become entities, what their ids are, what key a field is stored
under, whether a fragment applies — lives in `policies.ts`. It is the largest file in the
cache (1216 lines), and it is where `typePolicies`, `possibleTypes` and `dataIdFromObject`
flow in. (The other two configuration options go elsewhere: `resultCaching` to the
`EntityStore.Root`, and `fragments` to the reader, the writer and `transformDocument`.)

```mermaid
flowchart LR
    TP["<b>typePolicies</b><br/>keyFields · merge<br/>queryType etc.<br/>fields: keyArgs,<br/>read, merge"]:::ext
    PT["<b>possibleTypes</b><br/>supertype → subtypes[]"]:::ext
    DIF["<b>dataIdFromObject</b><br/>(global fallback)"]:::ext

    TBA["toBeAdded<br/>pending TypePolicy[]<br/>per typename"]:::store
    TPS["typePolicies (internal)<br/>keyFn · merge · fields<br/><i>materialised lazily</i>"]:::store
    RT["rootIdsByTypename<br/>rootTypenamesById"]:::store
    SM["supertypeMap<br/>subtype → Set#lt;supertype#gt;"]:::store
    FZ["fuzzySubtypes<br/>pattern → RegExp"]:::store
    KEX["key-extractor.ts<br/>specifier compilers"]:::memo

    ID["identify(object, ctx)<br/>→ [dataId?, keyObject?]"]:::write
    SFN["getStoreFieldName(spec)<br/>→ storeFieldName"]:::write
    RF["readField(options, ctx)<br/>runs read functions"]:::read
    GM["getMergeFunction ·<br/>runMergeFunction"]:::write
    HKA["hasKeyArgs"]:::read
    FM["fragmentMatches"]:::read

    TP --> TBA --> TPS
    TP --> RT
    PT --> SM & FZ
    TPS --> ID & SFN & RF & GM & HKA
    KEX --> ID & SFN
    DIF --> ID
    RT --> ID
    SM & FZ --> FM

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

## 3.1 Lazy materialisation and supertype inheritance

`addTypePolicies` does **not** install policies. It pushes them into a per-typename inbox:

```ts
// cache/inmemory/policies.ts
public addTypePolicies(typePolicies: TypePolicies) {
  Object.keys(typePolicies).forEach((typename) => {
    const { queryType, mutationType, subscriptionType, ...incoming } = typePolicies[typename];
    // Though {query,mutation,subscription}Type configurations are rare,
    // it's important to call setRootTypename as early as possible, ...
    if (queryType) this.setRootTypename("Query", typename);
    if (mutationType) this.setRootTypename("Mutation", typename);
    if (subscriptionType) this.setRootTypename("Subscription", typename);

    if (hasOwn.call(this.toBeAdded, typename)) {
      this.toBeAdded[typename].push(incoming);
    } else {
      this.toBeAdded[typename] = [incoming];
    }
  });
}
```

The inbox is drained by `getTypePolicy(typename)`, which runs its inheritance step **at most
once per typename** and then drains any pending updates:

```mermaid
flowchart TB
    CALL["getTypePolicy(typename)"]:::api --> HAS{"hasOwn(this.typePolicies, typename)?"}:::read
    HAS -->|"yes — already materialised"| DRAIN
    HAS -->|"no — first access"| CREATE["typePolicies[typename] = { fields: {} }"]:::store
    CREATE --> SUP["supertypes = supertypeMap.get(typename)"]:::read
    SUP -->|"none, and fuzzySubtypes.size"| FUZZ["create empty supertype set,<br/>add supertypes of every fuzzy<br/>RegExp that matches typename"]:::read
    SUP -->|"found"| INH
    SUP -->|"none, no fuzzy subtypes"| DRAIN
    FUZZ --> INH["for each supertype (insertion order):<br/>Object.assign(policy, {...rest})<br/>Object.assign(policy.fields, fields)<br/><i>recursive: getTypePolicy(supertype)</i>"]:::write
    INH --> DRAIN["inbox = toBeAdded[typename]<br/>inbox.splice(0).forEach(updateTypePolicy)"]:::write
    DRAIN --> RET["return typePolicies[typename]"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
```

Three consequences that the source comments call out explicitly:

- **Order-independence, but only until first use.** You may add policies for a subtype
  before its supertype, as long as both are registered before the first `getTypePolicy`
  call for the subtype. After that, `// future changes to inherited supertype policies
  will not be reflected in this subtype policy, because this code runs at most once per
  typename.`
- **Field-policy inheritance is atomic.** `updateTypePolicy` refuses to merge an inherited
  field policy with a new one, because `read` and `merge` cooperate:

  ```ts
  // Field policy inheritance is atomic/shallow: you can't inherit a
  // field policy and then override just its read function, since read
  // and merge functions often need to cooperate, ...
  if (!existing || existing?.typename !== typename) {
    existing = existingFieldPolicies[fieldName] = { typename };
  }
  ```

  The `typename` stamp on `InternalFieldPolicy` exists solely to detect "this entry was
  inherited from a supertype, so replace it wholesale."
- **Root typenames are immutable after the first assignment.**
  `setRootTypename` throws `Cannot change root Query __typename more than once` if you try
  to move `ROOT_QUERY` twice.

## 3.2 Entity identity: `Policies.identify`

```mermaid
flowchart TB
    START["identify(object, partialContext?)"]:::api
    START --> TN["typename =<br/>partialContext.typename ||<br/>partialContext.storeObject.__typename ||<br/>object.__typename"]:::read
    TN --> RQ{"typename === rootTypenamesById.ROOT_QUERY?"}:::read
    RQ -->|"yes"| RETQ["return ['ROOT_QUERY']<br/><i>no keyObject</i>"]:::api
    RQ -->|"no"| CTX["storeObject = partialContext.storeObject || object<br/>context.readField defaults to a reader<br/>bound to cache['data'] (the Root, or the<br/>active Layer inside an optimistic batch)"]:::store
    CTX --> PICK["keyFn = getTypePolicy(typename).keyFn<br/>|| config.dataIdFromObject"]:::read
    PICK --> LOOP{"keyFn?"}:::write
    LOOP -->|"undefined"| NOID["id = undefined"]:::dirty
    LOOP -->|"defined"| RUN["specifierOrId = keyFn({...object, ...storeObject}, context)<br/><i>inside disableWarningsSlot.withValue(true)</i>"]:::write
    RUN --> ARR{"isArray(specifierOrId)?"}:::write
    ARR -->|"yes — a KeySpecifier"| COMPILE["keyFn = keyFieldsFnFromSpecifier(specifierOrId)<br/>loop again"]:::memo
    COMPILE --> LOOP
    ARR -->|"no"| SET["id = specifierOrId; break"]:::write
    SET --> COERCE["id = id ? String(id) : undefined"]:::dirty
    NOID --> COERCE
    COERCE --> OUT["return context.keyObject ? [id, keyObject] : [id]"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Details that are easy to miss and that change behaviour:

- **The `while (keyFn)` loop supports indirection.** A `keyFields` *function* may return a
  `KeySpecifier` array, which is then compiled and re-invoked. Compiled specifier functions
  always return a string, so in practice there is at most one extra round. This is how a
  dynamic policy can defer to the declarative machinery.
- **`{ ...object, ...storeObject }`** is the argument, not `object`. During a write,
  `storeObject` is the partially-built normalized object (aliases resolved, children
  already turned into `Reference`s), and `object` is the raw result. Spreading gives the
  key function de-aliased values with raw values as a fallback.
- **`id ? String(id) : void 0` swallows falsy ids.** A key function that returns `0` or
  `""` makes the object unidentifiable. `defaultDataIdFromObject` is not affected: it checks
  the object's `id` with `!= null` and always returns a prefixed string such as `"Todo:0"`.
- **Only `ROOT_QUERY` gets the shortcut.** The comment explains why:
  `// It should be possible to write root Query fields with writeFragment, using
  { __typename: "Query", ... } as the data, but it does not make sense to allow the same
  identification behavior for the Mutation and Subscription types`.
- **`context.keyObject` is an out-parameter.** Key functions write to it so
  `StoreWriter` can merge the identifying fields into the store even when the query never
  selected them ([§4.5](04-store-writer.md#45-identification-and-the-keyobject-back-channel)).
- **`disableWarningsSlot`** silences data-masking warnings while key fields are read, so
  identifying a masked object does not spam the console.

### `defaultDataIdFromObject`

```ts
// cache/inmemory/helpers.ts
export function defaultDataIdFromObject(
  { __typename, id, _id }: Readonly<StoreObject>,
  context?: KeyFieldsContext
): string | undefined {
  if (typeof __typename === "string") {
    if (context) {
      context.keyObject =
        id != null ? { id }
        : _id != null ? { _id }
        : void 0;
    }
    // If there is no object.id, fall back to object._id.
    if (id == null && _id != null) { id = _id; }
    if (id != null) {
      return `${__typename}:${
        typeof id === "number" || typeof id === "string" ? id : JSON.stringify(id)
      }`;
    }
  }
}
```

Returning `undefined` — no `__typename`, or no `id`/`_id` — is the signal for
**"do not normalize"**. The object stays inline in its parent, exactly as
`EditTodoResponse` did in [§0.2](00-orientation.md#02-the-blogs-example-as-the-cache-actually-stores-it).

### `keyFields` specifiers

`keyFieldsFnFromSpecifier` compiles a `KeySpecifier` — a nested array of strings — into a
key function. The output format is `${typename}:${JSON.stringify(keyObject)}`:

```ts
// cache/inmemory/key-extractor.ts
return (
  info.keyFieldsFn ||
  (info.keyFieldsFn = (object, context) => {
    const extract: typeof extractKey = (from, key) => context.readField(key, from);

    const keyObject = (context.keyObject = collectSpecifierPaths(specifier, (schemaKeyPath) => {
      let extracted = extractKeyPath(
        context.storeObject,
        schemaKeyPath,
        // Using context.readField to extract paths from context.storeObject
        // allows the extraction to see through Reference objects and respect
        // custom read functions.
        extract
      );

      if (extracted === void 0 && object !== context.storeObject &&
          hasOwn.call(object, schemaKeyPath[0])) {
        // If context.storeObject fails to provide a value for the requested
        // path, fall back to the raw result object, ...
        extracted = extractKeyPath(object, schemaKeyPath, extractKey);
      }

      invariant(extracted !== void 0,
        `Missing field '%s' while extracting keyFields from %s`,
        schemaKeyPath.join("."), object);

      return extracted;
    }));

    return `${context.typename}:${JSON.stringify(keyObject)}`;
  })
);
```

The blog's nested example, `keyFields: ["title", "author", ["name"]]`, means "title, plus
`author.name`". `getSpecifierPaths` turns that flat-with-nesting notation into explicit
paths:

```mermaid
flowchart TB
    SPEC["KeySpecifier<br/>['title', 'author', ['name']]"]:::ext --> GSP["getSpecifierPaths"]:::memo
    GSP --> P1["path: ['title']"]:::store
    GSP --> P2["path: ['author', 'name']"]:::store
    P1 --> EX1["extractKeyPath(storeObject,<br/>['title'], readField)<br/>→ 'Fahrenheit 451'"]:::read
    P2 --> EX2["extractKeyPath(storeObject,<br/>['author', 'name'], readField)<br/>→ 'Ray Bradbury'<br/><i>readField sees through { __ref }</i>"]:::read
    EX1 --> CSP["collectSpecifierPaths<br/>one DeepMerger, paths merged in order:<br/>{ title } then { author: { name } }"]:::memo
    EX2 --> CSP
    CSP --> KO["keyObject — insertion order = path order<br/>{ title: 'Fahrenheit 451',<br/>author: { name: 'Ray Bradbury' } }"]:::store
    KO --> OUT["dataId = typename + ':' + JSON.stringify(keyObject)<br/>Book:{#quot;title#quot;:#quot;Fahrenheit 451#quot;,<br/>#quot;author#quot;:{#quot;name#quot;:#quot;Ray Bradbury#quot;}}"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

**The specifier's order is part of the cache key.** `collectSpecifierPaths` merges path
fragments in path order into a fresh object, and `JSON.stringify` emits properties in
insertion order, so the specifier order survives into the `dataId` verbatim:

```
keyFields: ["title", "author", ["name"]]
  → Book:{"title":"Fahrenheit 451","author":{"name":"Ray Bradbury"}}
keyFields: ["author", ["name"], "title"]
  → Book:{"author":{"name":"Ray Bradbury"},"title":"Fahrenheit 451"}
```

Two policies that list the same fields in different orders produce **different ids for the
same object**. Reordering a `keyFields` array is a breaking change for any persisted
`extract()` snapshot. Probe section 2 pins the exact strings.

`extractKeyPath` finishes with `normalize`, which recursively **sorts the keys** of any
object it extracted:

```ts
function normalize<T>(value: T): T {
  // Usually the extracted value will be a scalar value, ... but just in case we get an
  // object or an array, we need to do some normalization of the order of (nested) keys.
  if (isNonNullObject(value)) {
    if (isArray(value)) return value.map(normalize) as any;
    return collectSpecifierPaths(Object.keys(value).sort(), (path) => extractKeyPath(value, path)) as T;
  }
  return value;
}
```

So an *object-valued* key field is order-insensitive, while the *specifier itself* is
order-sensitive. That asymmetry is deliberate but surprising.

A missing key field is a **thrown invariant**, not a silent fallback. `StoreWriter` catches
it only when an explicit `dataId` was supplied:

```ts
// cache/inmemory/writeToStore.ts
} catch (e) {
  // If dataId was provided, tolerate failure of policies.identify.
  if (!dataId) throw e;
}
```

## 3.3 Field identity: `getStoreFieldName`

This is the function that turns `feed(type: "top")` into the store key
`feed({"type":"top"})`.

```mermaid
flowchart TB
    IN["getStoreFieldName({ typename, fieldName, field?, args?, variables? })"]:::api
    IN --> POL["policy = getFieldPolicy(typename, fieldName)<br/>keyFn = policy?.keyFn"]:::read
    POL --> HAS{"keyFn #amp;#amp; typename?"}:::read

    HAS -->|"yes"| KLOOP["specifierOrString = keyFn(args, { typename, fieldName, field, variables })"]:::write
    KLOOP --> KARR{"isArray?"}:::write
    KARR -->|"yes"| KCOMP["keyFn = keyArgsFnFromSpecifier(...)<br/>loop"]:::memo
    KCOMP --> KLOOP
    KARR -->|"no"| KSET["storeFieldName = specifierOrString || fieldName<br/><i>false, empty string or undefined → fieldName</i>"]:::write

    HAS -->|"no"| DEF
    KSET --> UNDEF{"storeFieldName === undefined?"}:::write
    UNDEF -->|"yes"| DEF["field ?<br/>storeKeyNameFromField(field, variables)<br/>: getStoreKeyName(fieldName, args)"]:::write
    UNDEF -->|"no"| FALSE
    DEF --> FALSE{"storeFieldName === false?"}:::write
    FALSE -->|"yes — defensive: KSET already<br/>maps false to fieldName"| RETF["return fieldName"]:::api
    FALSE -->|"no"| PREFIX{"fieldName === fieldNameFromStoreName(storeFieldName)?"}:::read
    PREFIX -->|"yes"| RET1["return storeFieldName"]:::api
    PREFIX -->|"no — custom key lost the prefix"| RET2["return fieldName + ':' + storeFieldName"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

The **prefix repair** at the bottom is what guarantees `fieldNameFromStoreName` is always
invertible:

```ts
// Make sure custom field names start with the actual field.name.value
// of the field, so we can always figure out which properties of a
// StoreObject correspond to which original field names.
return fieldName === fieldNameFromStoreName(storeFieldName) ? storeFieldName
  : fieldName + ":" + storeFieldName;
```

`fieldNameFromStoreName` is a regex prefix match (`/^[_a-z][_0-9a-z]*/i`), so
`feed({"type":"top"})` → `feed`. A `keyArgs` function returning `"weird key"` would break
that inversion, so the result becomes `feed:weird key`. Everything downstream —
`CacheGroup.depend`'s two-level keys, `modify`'s two-level modifier lookup,
`evict({ fieldName })`, `merge`'s short-name dirtying — depends on this invariant.

The default (no `keyArgs`) path is `storeKeyNameFromField` → `getStoreKeyName`, which
serialises the arguments with `canonicalStringify`. `canonicalStringify` sorting is what
makes `feed(type: "top", limit: 10)` and `feed(limit: 10, type: "top")` the same key.
Directives affect the default key in two ways:

- `@connection(key: "k")` **replaces** the field name with `k` when the field has
  arguments. With `filter: ["a", ...]`, only those arguments are appended, as
  `k({"a":...})`. (The prefix repair above then turns `k` into `feed:k`.)
- Directives outside a fixed known list are **appended**: `@name` or `@name({...args})`.
  The known list (`connection`, `include`, `skip`, `client`, `rest`, `export`,
  `nonreactive`, `stream`) never appears in the key.

### `keyArgs` specifiers

`keyArgsFnFromSpecifier` supports three namespaces in a key path's first segment:

| Prefix | Source | Missing-value behaviour |
| --- | --- | --- |
| `"@directiveName"` | `field.directives` → `argumentsObjectFromField(d, variables)` | Directive absent → omitted from the key. Directive present without args → `null` recorded (presence itself is part of the key). |
| `"$variableName"` | `context.variables` | Variable absent → omitted. |
| anything else | the field's `args` object | Argument absent → omitted. |

```ts
const suffix = JSON.stringify(collected);
// If no arguments were passed to this field, and it didn't have any other
// field key contributions from directives or variables, hide the empty
// :{} suffix from the field key. ...
if (args || suffix !== "{}") { fieldName += ":" + suffix; }
return fieldName;
```

So `keyArgs: ["type"]` on a field called with `feed(type: "top", limit: 10)` produces
`feed:{"type":"top"}` — the `limit` argument no longer partitions the cache, which is the
foundation of every pagination policy. Compare with the default key
`feed({"limit":10,"type":"top"})`. Probe section 3 prints both.

`keyArgs: false` compiles to `simpleKeyArgsFn = (_args, context) => context.fieldName`, so
all argument variants collapse onto the bare field name.

There is one **implicit** `keyArgs` assignment worth memorising:

```ts
if (existing.read && existing.merge) {
  // If we have both a read and a merge function, assume
  // keyArgs:false, because read and merge together can take
  // responsibility for interpreting arguments in and out. ...
  existing.keyFn = existing.keyFn || simpleKeyArgsFn;
}
```

Defining both `read` and `merge` for a field silently turns on `keyArgs: false`. This also
makes `hasKeyArgs(typename, fieldName)` return `true`, which suppresses short-name dirtying
in `EntityStore.merge` ([§2.6](02-normalized-store.md#26-writes-merge-and-storeobjectreconciler)).

### Where `storeFieldName` is decided, end to end

```mermaid
sequenceDiagram
    autonumber
    participant SW as StoreWriter
    participant P as Policies
    participant KE as compiled keyFn
    participant CS as canonicalStringify

    SW->>P: getStoreFieldName({ typename: "Query",<br/>fieldName: "feed", field, variables })
    P->>P: getFieldPolicy("Query", "feed")<br/>→ { keyFn? }
    alt keyArgs: ["type"] configured
        Note over P,KE: keyFn was compiled once by<br/>keyArgsFnFromSpecifier when the<br/>type policy was materialised
        P->>KE: keyFn(args, { typename,<br/>fieldName, field, variables })
        KE->>KE: collectSpecifierPaths → { type: "top" }<br/>JSON.stringify
        KE-->>P: 'feed:{"type":"top"}'
    else no keyArgs
        P->>P: storeKeyNameFromField<br/>(field, variables)
        P->>CS: canonicalStringify(<br/>{ limit: 10, type: "top" })
        CS-->>P: '{"limit":10,"type":"top"}'
        P-->>P: 'feed({"limit":10,"type":"top"})'
    end
    P->>P: prefix check via<br/>fieldNameFromStoreName
    P-->>SW: storeFieldName
    SW->>SW: incoming = context.merge(incoming,<br/>{ [storeFieldName]: value })
```

## 3.4 `readField` — the field read entry point

Every field read in the cache funnels through `Policies.readField`, whether it comes from
`StoreReader`, from a user `read` function, from a `modify` modifier, or from a `keyFields`
extractor.

```ts
public readField<V = StoreValue>(
  options: ReadFieldOptions,
  context: ReadMergeModifyContext
): SafeReadonly<V> | undefined {
  const objectOrReference = options.from;
  if (!objectOrReference) return;
  const nameOrField = options.field || options.fieldName;
  if (!nameOrField) return;

  if (options.typename === void 0) {
    const typename = context.store.getFieldValue<string>(objectOrReference, "__typename");
    if (typename) options.typename = typename;
  }

  const storeFieldName = this.getStoreFieldName(options);
  const fieldName = fieldNameFromStoreName(storeFieldName);
  const existing = context.store.getFieldValue<V>(objectOrReference, storeFieldName);
  const policy = this.getFieldPolicy(options.typename, fieldName);
  const read = policy && policy.read;

  if (read) {
    const readOptions = makeFieldFunctionOptions(
      this, objectOrReference, options, context,
      context.store.getStorage(
        isReference(objectOrReference) ? objectOrReference.__ref : objectOrReference,
        storeFieldName
      )
    );
    // Call read(existing, readOptions) with cacheSlot holding this.cache.
    return cacheSlot.withValue(this.cache, read, [existing, readOptions]) as SafeReadonly<V>;
  }

  return existing;
}
```

```mermaid
flowchart TB
    RFC["readField(options, context)"]:::api --> FROM{"options.from?"}:::read
    FROM -->|"falsy"| U1["return undefined"]:::dirty
    FROM -->|"present"| TN["typename ??= store.getFieldValue(from, '__typename')<br/><i>registers a dependency on __typename</i>"]:::read
    TN --> SFN["storeFieldName = getStoreFieldName(options)"]:::write
    SFN --> GET["existing = store.getFieldValue(from, storeFieldName)<br/><i>maybeDeepFreeze + group.depend</i>"]:::store
    GET --> RD{"field policy has read?"}:::read
    RD -->|"no"| RETE["return existing"]:::api
    RD -->|"yes"| OPTS["build FieldFunctionOptions:<br/>args · fieldName · storeFieldName · field ·<br/>variables · isReference · toReference ·<br/>storage · cache · canRead · readField · mergeObjects"]:::write
    OPTS --> SLOT["cacheSlot.withValue(this.cache, read, [existing, options])"]:::memo
    SLOT --> RV["reactive vars read inside<br/>attach to this cache and<br/>register a dep"]:::memo
    SLOT --> RETR["return read(...) — may be undefined<br/>(counts as a missing field)"]:::api

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Four properties of this function drive most of the cache's advanced behaviour:

1. **`read` functions run inside the memoized read.** They execute within the `optimism`
   `Entry` for `executeSelectionSet`, so *any* `store.get` they trigger (via `readField`)
   is recorded as a dependency of the enclosing memoized subtree. A cache redirect,
   `read: (_, { args, toReference }) => toReference({ __typename: "Book", id: args.id })`,
   reads nothing from the store itself: it just returns a `Reference`. It still stays
   current, because `StoreReader` then reads the target through its own
   `executeSelectionSet` entry, a child of the current one. That child depends on the
   target's fields and, through `has()`, on its `__exists`, so both the target's creation
   and later changes invalidate the redirecting query. Probe section 11 pins the redirect
   itself; the invalidation was verified separately with a `cache.watch`.
2. **`cacheSlot` is how reactive variables find their cache.** `makeVar`'s getter calls
   `cacheSlot.getValue()`; if a cache is present it attaches itself and registers a
   dependency on the variable. Without the slot, a reactive variable read inside a `read`
   function could not know which cache to notify.
3. **`options.storage` is per-`(entity, storeFieldName)` and survives across reads.**
   `Root.storageTrie` (a `Trie<StorageType>`) hands out a stable object identity for the
   path `(idOrObj, ...storeFieldNames)`. It is a scratch space for custom `read` and
   `merge` functions. (Apollo's own pagination helpers do not use it:
   `relayStylePagination` keeps its cursors inside the stored field value.) For a
   non-normalized parent the path starts with the object itself, held weakly, so the
   storage lives only as long as that object does.
4. **Returning `undefined` from a `read` function means "missing".** `StoreReader` treats
   `undefined` exactly as it treats an absent store field, producing a `MissingFieldError`
   entry. Returning `null` is a real value.

`normalizeReadFieldOptions` is the adapter that lets `readField` be called in four ways:

```ts
export function normalizeReadFieldOptions(readFieldArgs, objectOrReference, variables) {
  const { 0: fieldNameOrOptions, 1: from, length: argc } = readFieldArgs;
  let options: ReadFieldOptions;
  if (typeof fieldNameOrOptions === "string") {
    options = {
      fieldName: fieldNameOrOptions,
      // Default to objectOrReference only when no second argument was
      // passed for the from parameter, not when undefined is explicitly
      // passed as the second argument.
      from: argc > 1 ? from : objectOrReference,
    };
  } else {
    options = { ...fieldNameOrOptions };
    // Default to objectOrReference only when fieldNameOrOptions.from is
    // actually omitted, rather than just undefined.
    if (!hasOwn.call(options, "from")) { options.from = objectOrReference; }
  }
  if (__DEV__ && options.from === void 0) {
    invariant.warn(`Undefined 'from' passed to readField with arguments %s`, ...);
  }
  if (void 0 === options.variables) { options.variables = variables; }
  return options;
}
```

Both defaulting rules use *arity/own-property* checks rather than `=== undefined`, so
`readField("name", undefined)` reads from `undefined` (and returns `undefined`) instead of
silently reading from the current object. Development builds also warn about it.

## 3.5 Merge functions

Two places in the configuration can supply a merge function, resolved by
`getMergeFunction(parentTypename, fieldName, childTypename)`. (When neither does, the
writer falls back to a built-in merge only for `@stream` list fields.)

```mermaid
flowchart TB
    Q["getMergeFunction('Query', 'author', 'Author')"]:::api --> F["1. field policy<br/>typePolicies.Query.fields.author.merge"]:::write
    F -->|"found"| USE["use it"]:::store
    F -->|"not found"| T["2. child type policy<br/>typePolicies.Author.merge"]:::write
    T -->|"found"| USE
    T -->|"not found"| NONE["undefined → no merge<br/>incoming replaces existing<br/><i>(and __DEV__ may warn)</i>"]:::dirty

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Field policies win over type policies. `merge: true` and `merge: false` are compiled to
singleton functions at configuration time:

```ts
const mergeTrueFn: FieldMergeFunction<any> = (existing, incoming, { mergeObjects }) =>
  mergeObjects(existing, incoming);
const mergeFalseFn: FieldMergeFunction<any> = (_, incoming) => incoming;
```

and `runMergeFunction` short-circuits on their **identity**, avoiding the cost of building
a `FieldMergeFunctionOptions` object:

```ts
public runMergeFunction(existing, incoming, { field, typename, merge, path }, context, storage?) {
  const existingData = existing;   // Preserve the value in case `context.overwrite` is set.
  if (merge === mergeTrueFn) {
    // Instead of going to the trouble of creating a full FieldFunctionOptions
    // object and calling mergeTrueFn, we can simply call mergeObjects, ...
    return makeMergeObjectsFunction(context.store)(existing as StoreObject, incoming as StoreObject);
  }
  if (merge === mergeFalseFn) { return incoming; }

  // If cache.writeQuery or cache.writeFragment was called with options.overwrite
  // set to true, we still call merge functions, but the existing data is always
  // undefined, ...
  if (context.overwrite) { existing = void 0; }
  // ... @stream memoization elided ...
  const result = merge(existing, incoming, makeMergeFieldFunctionOptions(/* ... */));
  return result;
}
```

Note that `overwrite: true` does **not** skip custom merge functions: it blanks `existing`
and passes the original through as `options.existingData`. The two singletons are checked
*before* that line, so they ignore `overwrite`: a field with `merge: true` still merges
the incoming object with the stored one during an overwrite (verified: with
`overwrite: true`, a `merge: true` field keeps a stored `theme` that the incoming object
lacks, while a custom merge function receives `existing === undefined`).

### `mergeObjects`

```ts
function makeMergeObjectsFunction(store: NormalizedCache): MergeObjectsFunction {
  return function mergeObjects(existing, incoming) {
    if (isArray(existing) || isArray(incoming)) {
      throw newInvariantError("Cannot automatically merge arrays");
    }
    if (isNonNullObject(existing) && isNonNullObject(incoming)) {
      const eType = store.getFieldValue(existing, "__typename");
      const iType = store.getFieldValue(incoming, "__typename");
      const typesDiffer = eType && iType && eType !== iType;
      if (typesDiffer) { return incoming; }

      if (isReference(existing) && storeValueIsStoreObject(incoming)) {
        // Update the normalized EntityStore for the entity identified by
        // existing.__ref, preferring/overwriting any fields contributed by the
        // newer incoming StoreObject.
        store.merge(existing.__ref, incoming);
        return existing;
      }
      if (storeValueIsStoreObject(existing) && isReference(incoming)) {
        // Update the normalized EntityStore for the entity identified by
        // incoming.__ref, taking fields from the older existing object only if
        // those fields are not already present in the newer StoreObject ...
        store.merge(existing, incoming.__ref);
        return incoming;
      }
      if (storeValueIsStoreObject(existing) && storeValueIsStoreObject(incoming)) {
        return { ...existing, ...incoming };
      }
    }
    return incoming;
  };
}
```

```mermaid
flowchart TB
    MO["mergeObjects(existing, incoming)"]:::api --> ARR{"either is an array?"}:::read
    ARR -->|"yes"| THROW["throw 'Cannot automatically merge arrays'"]:::dirty
    ARR -->|"no"| OBJ{"both non-null objects?"}:::read
    OBJ -->|"no"| INC["return incoming"]:::store
    OBJ -->|"yes"| TYP{"__typename differs?"}:::read
    TYP -->|"yes"| INC
    TYP -->|"no"| CASE{"shapes"}:::read
    CASE -->|"Ref + StoreObject"| C1["store.merge(existing.__ref, incoming)<br/>return existing (the Reference)"]:::write
    CASE -->|"StoreObject + Ref"| C2["store.merge(existing, incoming.__ref)<br/>return incoming (the Reference)"]:::write
    CASE -->|"StoreObject + StoreObject"| C3["return { ...existing, ...incoming }<br/><i>shallow</i>"]:::store
    CASE -->|"Ref + Ref (same id or not)"| INC

    classDef api fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

The two mixed cases have a **side effect on the store**, writing directly rather than
returning a value to be written. That is why `StoreWriter.writeToStore` checks whether
`applyMerges` returned a `Reference` before merging the result again:

```ts
// cache/inmemory/writeToStore.ts
if (isReference(applied)) {
  // Assume References returned by applyMerges have already been merged
  // into the store. See makeMergeObjectsFunction in policies.ts for an
  // example of how this can happen.
  return;
}
```

`mergeObjects` is also **shallow** for the object/object case, so `merge: true` on a
grandparent does not recursively protect grandchildren (unless they have merge functions
of their own). Probe section 10 shows the object/object case: `merge: true` on a
non-normalized type combines two partial writes (`{ theme }` then `{ locale }`), which the
default field-wise replace would lose. It does not exercise the mixed
`Reference`/`StoreObject` cases.

## 3.6 `fragmentMatches` — type-condition resolution

Without `possibleTypes`, the rule is trivially strict:

```ts
public fragmentMatches(fragment, typename, result?, variables?): boolean {
  if (!fragment.typeCondition) return true;
  // If the fragment has a type condition but the object we're matching
  // against does not have a __typename, the fragment cannot match.
  if (!typename) return false;
  const supertype = fragment.typeCondition.name.value;
  // Common case: fragment type condition and __typename are the same.
  if (typename === supertype) return true;
  // ... possibleTypes search ...
  return false;
}
```

With `possibleTypes`, the search runs **upwards** over the inverted map:

```mermaid
flowchart LR
    CFG["possibleTypes: {<br/>Character: ['Jedi', 'Droid'],<br/>Jedi: ['Padawan']<br/>}"]:::ext
    CFG -->|"addPossibleTypes<br/>inverts it"| MAP["supertypeMap:<br/>Character → {}<br/>Jedi → { Character }<br/>Droid → { Character }<br/>Padawan → { Jedi }"]:::store

    classDef store fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef ext fill:#e2e8f0,stroke:#475569,stroke-width:2px,color:#0f172a
```

The search for `fragmentMatches(fragment on Character, 'Padawan')` then walks upwards:

```mermaid
flowchart TB
    S0["fragmentMatches('Character', typename = 'Padawan')<br/>workQueue = [ supertypeSet('Padawan') = { Jedi } ]"]:::read
    S0 --> S1{"does { Jedi } contain 'Character'?"}:::read
    S1 -->|"no"| S2["enqueue supertypeSet('Jedi') = { Character }"]:::read
    S2 --> S3{"does { Character } contain 'Character'?"}:::read
    S3 -->|"yes"| S4["memoize: supertypeSet('Padawan').add('Character')<br/>return true"]:::memo

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef memo fill:#e9d5ff,stroke:#7c3aed,stroke-width:2px,color:#0f172a
```

Fuzzy subtypes (a `possibleTypes` entry that is not a plain type name, such as
`"Jedi.*"`) are consulted only while writing, and only after the normal search fails:

```mermaid
flowchart TB
    F0["typename still unmatched after<br/>the non-fuzzy queue is exhausted"]:::dirty
    F0 --> F1{"a result object was passed (writes only)<br/>AND selectionSetMatchesResult(fragment, result)?"}:::read
    F1 -->|"no"| F2["return false"]:::dirty
    F1 -->|"yes"| F3["enqueue the supertypes of every fuzzy RegExp<br/>that fully matches typename<br/><i>development builds warn<br/>'Inferring subtype X of supertype Y'</i>"]:::write

    classDef read fill:#ccfbf1,stroke:#0d9488,stroke-width:2px,color:#0f172a
    classDef write fill:#fde68a,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef dirty fill:#fecaca,stroke:#dc2626,stroke-width:2px,color:#0f172a
```

Three subtleties:

- **Positive results are memoized; negative results are not.**
  `// Unfortunately, we cannot safely cache negative results, because new possibleTypes
  data could always be added to the Policies class.` A deep interface hierarchy therefore
  pays full BFS cost on every *miss*, forever.
- **Fuzzy subtypes only apply while writing.** `StoreReader` calls `fragmentMatches` with
  no `result` argument, so `needToCheckFuzzySubtypes` is always false there. Read and write
  can therefore disagree about a fuzzy fragment — deliberately, since only the write path
  has a result object to shape-match against.
- **The queue grows during iteration.** `for (let i = 0; i < workQueue.length; ++i)` is an
  explicit BFS with dedup via `workQueue.indexOf(supertypeSet) < 0`, which is a linear scan
  — fine for the small sets that real schemas produce.

`selectionSetMatchesResult` is the shape test used for fuzzy matching. It requires every
non-skipped field of the fragment to be an own property of the result, recursively, and it
maps over arrays:

```ts
// cache/inmemory/helpers.ts
export function selectionSetMatchesResult(selectionSet, result, variables): boolean {
  if (isNonNullObject(result)) {
    return isArray(result) ?
        result.every((item) => selectionSetMatchesResult(selectionSet, item, variables))
      : selectionSet.selections.every((field) => {
          if (isField(field) && shouldInclude(field, variables)) {
            const key = resultKeyNameFromField(field);
            return hasOwn.call(result, key) &&
              (!field.selectionSet ||
                selectionSetMatchesResult(field.selectionSet, result[key], variables));
          }
          // If the selection has been skipped with @skip(true) or @include(false), it
          // should not count against the matching. ...
          return true;
        });
  }
  return false;
}
```

Probe section 12 pins interface/union matching: an exact typename match, a direct subtype,
a transitive subtype, and an unrelated typename that does not match. Without any
`possibleTypes`, only an exact typename match (or a fragment with no type condition)
matches; there is no fallback and no warning.

<!-- nav:bottom -->

---

| ← Previous | Up | Next → |
| :-- | :-: | --: |
| [Part 2 — The normalized store](02-normalized-store.md) | [Architecture guide](README.md) | [Part 4 — `StoreWriter`](04-store-writer.md) |
