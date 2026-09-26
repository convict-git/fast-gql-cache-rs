---
status: accepted
---

# Initialize the WASM synchronously, inside the constructor, from bytes in the package

`new InMemoryCacheRs(config)` must work exactly like `new InMemoryCache(config)`: it is
synchronous and needs no setup step. So the package ships its WASM bytes inside its
JavaScript, and the constructor calls wasm-bindgen's `initSync` with them the first time a
cache is created. No initialization function is exported, and nothing changes for users of
the public surface.

## Context

- **Today's package cannot construct a cache outside Jest.** The published ESM entry
  imports the web-target glue and calls into the WASM in the constructor, but nothing
  initializes it, and the entry exports no initializer. The call throws
  `TypeError: Cannot read properties of undefined (reading '__wbindgen_free')`. Jest only
  works because it maps to the self-initializing nodejs build (ADR 0001, F18, E8).
- **The constructor has to stay synchronous.** `ApolloClient` takes a constructed cache,
  and applications build both at module load. An `await` anywhere would change every
  adopter's setup (ADR 0002, tier 2).
- **Synchronous compilation is allowed in browsers.** Chrome refused a synchronous
  `new WebAssembly.Module()` over 4 KB on the main thread until Chrome 115, which raised
  the limit to 8 MB ([chromestatus 5099433642950656](https://chromestatus.com/feature/5099433642950656);
  an earlier [intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/nJw2zwaiJ2s/m/EYPgC5D3LwAJ)
  proposed removing it). Bigger modules must compile asynchronously or on a worker. Other
  browsers have not been checked.

## Decision

- **Default.** The build emits the release `.wasm` as a base64 string in a JS module. On
  first construction, `InMemoryCacheRs` decodes it and calls `initSync({ module: bytes })`;
  later constructions reuse the instance. One ESM build serves browsers, Node and SSR.
  Jest keeps the nodejs `.cjs` mapping until it can use the same path.
- **A size budget.** The release `.wasm` stays far below 8 MB. CI fails the build at
  1 MB, a limit to revisit with measurements, because synchronous compilation blocks the
  main thread for longer as the module grows.
- **One instance per realm.** Every cache shares it (F19), which is why ADR 0001 poisons
  the whole instance on a trap.
- **No public initializer for now.** If the bundled bytes prove too costly (A8 measures
  the gzipped size), the escape hatch is a static `InMemoryCacheRs.init(source)` that
  fetches or compiles the `.wasm` asynchronously ahead of time. It is a static method, so
  the public exports stay `InMemoryCacheRs` and `InMemoryCacheRsConfig`.

## Considered options

- **Exporting `initSync(bytes)` and requiring apps to call it.** Rejected as the default:
  it adds a setup step, and every bundler needs its own configuration just to obtain the
  bytes synchronously.
- **An async `await InMemoryCacheRs.create()` or `await init()`.** Rejected: cache and
  client construction would become async, which breaks the drop-in shape.
- **Top-level `await` in the entry module.** Rejected: it forces ESM-only consumers,
  stalls the importing module graph, and has uneven support in bundlers and test runners.

## Consequences

- Base64 inflates the bytes by a third before compression. The bundle-size cost is real,
  and it is why A8 measures it.
- Any page with a Content Security Policy must allow WASM compilation
  (`'wasm-unsafe-eval'`), whichever loading method is used (unverified).
- The first `new InMemoryCacheRs()` pays for decoding and compilation. With V8's lazy
  WASM compilation this is expected to be small; A8 measures it.
