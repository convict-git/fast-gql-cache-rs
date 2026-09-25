#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Put rustup's proxies first so `wasm/rust-toolchain.toml` picks the toolchain, even
# when a specific toolchain's bin/ is also on PATH.
CARGO_BIN="${CARGO_HOME:-${HOME}/.cargo}/bin"

if [[ -d "${CARGO_BIN}" ]]; then
  export PATH="${CARGO_BIN}:${PATH}"
fi

cd "${ROOT}"

# Browser/bundler-facing ESM build. Emitted to the repo-root `pkg/` with the
# base name the TypeScript source imports (`../pkg/fast_gql_cache_rs.js`).
wasm-pack build wasm --target web --out-dir "${ROOT}/pkg" --out-name fast_gql_cache_rs "$@"

# Node/CommonJS build for Jest (jsdom/node). ts-jest maps the `.js` import to
# `pkg/fast_gql_cache_rs.cjs`; the nodejs target self-initializes the wasm
# synchronously on require, which the InMemoryCacheRs constructor relies on.
NODE_OUT="$(mktemp -d)"
trap 'rm -rf "${NODE_OUT}"' EXIT
wasm-pack build wasm --target nodejs --out-dir "${NODE_OUT}" --out-name fast_gql_cache_rs "$@"
cp "${NODE_OUT}/fast_gql_cache_rs.js" "${ROOT}/pkg/fast_gql_cache_rs.cjs"
