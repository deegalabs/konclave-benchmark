<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->
# Storage measurement (WebZjs, view-only)

Measures the wallet WebZjs saves after a view-only mainnet sync of the published test vault key: the bytes of
`db_to_bytes`, the origin's `navigator.storage.estimate()` after the IndexedDB write, the note count, the block range.
Method: the "Storage (option A)" section of the M1 run sheet. The WebZjs build is an unreleased open pull request
(red-dev-inc/WebZjs#27); the commit is recorded in every output.

```
# 1. build the threaded package in a WebZjs checkout, then copy it in (prints the commit and the sha256)
(cd /path/to/WebZjs && just build-wallet)
storage/copy-pkg.sh /path/to/WebZjs
# 2. the local gRPC-web proxy (zec.rocks on :1234)
docker compose -f storage/proxy/compose.yml up -d
# 3. one run per birthday (run npm install once in storage/ for playwright-core)
node storage/run.mjs --birthday 3558848 --webzjs-commit <sha> --label reported --out storage/out/run-3558848.json
docker compose -f storage/proxy/compose.yml down
```

The driver uses a fresh throwaway profile and deletes it. It exits 1 and keeps the log if the page shows no console
activity for `--stall-minutes` (default 10). The page is served from `http://localhost:8091` (the port the proxy allows)
with COOP and COEP. Nothing in the page creates a spending key or calls propose, transfer or send.
