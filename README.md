# fast-gql-cache-rs - A rust-wasm based InMemoryCache implementation for apollo-client

## Setup dev environment

```bash
git config submodule.apollo-client-sm.url https://github.com/apollographql/apollo-client.git
git submodule update --init --recursive --depth 1
npm install
rustup toolchain install nightly --profile minimal --target wasm32-unknown-unknown
```
