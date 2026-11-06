#!/usr/bin/env bash
# Build the Mandate contract to res/mandate_near.wasm (cargo + wasm-opt -Oz).
# The judge demo deploys exactly this file, and so does scripts/deploy.ts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contract"
mkdir -p "$ROOT/res"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
# Remap machine-specific paths (cargo registry, repo location) that end up in panic
# location strings, so the same commit builds the same wasm on any machine.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-s --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$ROOT=/mandate-near" \
  cargo build --target wasm32-unknown-unknown --release --quiet
RAW=target/wasm32-unknown-unknown/release/mandate_near.wasm
OUT="$ROOT/res/mandate_near.wasm"
if [ -x "$ROOT/node_modules/.bin/wasm-opt" ]; then
  # Enable only the features rustc already emitted; wasm-opt shrinks ~20% (less storage staking).
  "$ROOT/node_modules/.bin/wasm-opt" -Oz --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext \
    --enable-mutable-globals --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
    --strip-debug --strip-producers "$RAW" -o "$OUT"
else
  cp "$RAW" "$OUT"
fi
echo "built res/mandate_near.wasm ($(wc -c < "$OUT") bytes, sha256 $(sha256sum "$OUT" | cut -c1-16)…)"
