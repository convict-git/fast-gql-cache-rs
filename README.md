# fast-gql-cache-rs - A rust-wasm based InMemoryCache implementation for apollo-client
Currently in the proof-of-concept phase, a drop-in replacement for [apollo-client’s `InMemoryCache`](https://www.apollographql.com/docs/react/v3/api/cache/InMemoryCache), intended to **improve client-side GraphQL caching performance** by moving performance-critical hot paths like read, write, and normalization to **Rust-WebAssembly** while minimizing JavaScript single-thread overhead, expecting smoother frame rates and near-zero loss of interactivity for applications with l**arge normalized stores and write-heavy workloads**.

### Checkout the hot-paths: [POC doc - Performance Deep Dive](https://github.com/convict-git/fast-gql-cache-rs/blob/main/docs/apollo-client-inmemory-cache-performance.md#apollo-client-inmemorycache--performance-deep-dive) 
### For curious minds, checkout how the `apollo-client`'s `InMemoryCache` works internally? [Deep Dive on InMemoryCache](https://github.com/convict-git/fast-gql-cache-rs/blob/main/docs/apollo-client-inmemory-cache.md#apollo-client-inmemorycache--deep-dive)

## Setup dev environment

```bash
git config submodule.apollo-client-sm.url https://github.com/apollographql/apollo-client.git
git submodule update --init --recursive --depth 1
npm install

# Skip the toolchain update if the nightly wasm32 target is already installed.
# On overlayfs-backed containers (common in cloud CI/agents), rustup's default
# atomic rename can fail with EXDEV during an update; RUSTUP_PERMIT_COPY_RENAME
# tells it to use a copy fallback instead.
if ! rustup target list --toolchain nightly --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown'; then
  export RUSTUP_PERMIT_COPY_RENAME=true
  rustup toolchain install nightly --profile minimal --target wasm32-unknown-unknown
fi
```
