#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTUP_BIN="${HOME}/.rustup/toolchains/nightly-aarch64-apple-darwin/bin"

if [[ -d "${RUSTUP_BIN}" ]]; then
  export PATH="${RUSTUP_BIN}:${PATH}"
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
