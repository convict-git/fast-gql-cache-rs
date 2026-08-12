#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUSTUP_BIN="${HOME}/.rustup/toolchains/nightly-aarch64-apple-darwin/bin"

if [[ -d "${RUSTUP_BIN}" ]]; then
  export PATH="${RUSTUP_BIN}:${PATH}"
fi

cd "${ROOT}"
exec wasm-pack build wasm --target web --out-dir pkg "$@"
