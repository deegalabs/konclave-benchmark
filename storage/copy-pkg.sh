#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copies the threaded WebZjs package (built by `just build-wallet` in a WebZjs checkout) into site/pkg and prints the
# checkout's commit and the sha256 of the build, so a result can be tied to a build.
# Usage: ./copy-pkg.sh /path/to/WebZjs
set -euo pipefail
root="${1:?usage: copy-pkg.sh <WebZjs checkout where just build-wallet was run>}"
src="$root/packages/webzjs-wallet"
[ -f "$src/webzjs_wallet_bg.wasm" ] || { echo "not built: $src (run: just build-wallet)"; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$here/site/pkg" && cp -r "$src" "$here/site/pkg"
echo "commit $(git -C "$root" rev-parse HEAD)"
sha256sum "$here/site/pkg/webzjs_wallet_bg.wasm" "$here/site/pkg/webzjs_wallet.js"
