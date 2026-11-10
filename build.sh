#!/bin/sh
# SPDX-License-Identifier: MIT OR Apache-2.0
# Builds both wasm flavours into web/ and records what was built. usage: ./build.sh [single|threads|all]
set -eu
cd "$(dirname "$0")"
WHAT="${1:-all}"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -z "$(git status --porcelain 2>/dev/null)" ] || COMMIT="$COMMIT-dirty"
stamp() {
  rm -f "$1/README.md" "$1/.gitignore" "$1/package.json"
  CRATES="$(awk -F'"' '/^name = /{n=$2} /^version = /{ if (n ~ /^(orchard|halo2_proofs|zcash_note_encryption|shardtree|incrementalmerkletree|blake2b_simd)$/) printf "%s\"%s\":\"%s\"", (c++?",":""), n, $2 }' Cargo.lock)"
  node scripts/stamp-meta.mjs "$1" "$COMMIT" "$2" "$3" "$CRATES"
}
if [ "$WHAT" != threads ]; then
  wasm-pack build --target web --release --out-dir web/pkg --no-typescript --locked
  stamp web/pkg single "$(rustc --version)"
fi
if [ "$WHAT" != single ]; then
  CARGO_UNSTABLE_BUILD_STD=panic_abort,std \
  RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--max-memory=4294967296 -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base' \
    wasm-pack build --target web --release --out-dir web/pkg-mt --no-typescript --features threads --locked
  stamp web/pkg-mt threads "$(rustc --version)"
fi
# The page's own script, stamped with the same commit: a result carries both, and the summary refuses a pair that differ.
node scripts/stamp-js.mjs "$COMMIT"
