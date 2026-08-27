# fast-gql-cache-rs - A rust-wasm based InMemoryCache implementation for apollo-client
Currently in the proof-of-concept phase, a drop-in replacement for [apollo-client’s `InMemoryCache`](https://www.apollographql.com/docs/react/v3/api/cache/InMemoryCache), intended to **improve client-side GraphQL caching performance** by moving performance-critical hot paths like read, write, and normalization to **Rust-WebAssembly** while minimizing JavaScript single-thread overhead, expecting smoother frame rates and near-zero loss of interactivity for applications with l**arge normalized stores and write-heavy workloads**.

## Setup dev environment

```bash
git config submodule.apollo-client-sm.url https://github.com/apollographql/apollo-client.git
git submodule update --init --recursive --depth 1
npm install
rustup toolchain install nightly --profile minimal --target wasm32-unknown-unknown
```
