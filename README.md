# konclave-benchmark

## What it measures

This is a measurement harness for what scanning and proving cost inside a browser, on phones and a laptop, timed stage by stage. It proves with the Orchard Action circuit of orchard 0.16.0 (key build, circuit preparation, proof and verify timed apart) and scans compact blocks (on a live row the tree state before the range, the download and the tree state at its end; then decode, trial decryption with the internal and the external viewing key across both pools, and the note commitment trees), timing witnesses apart. A row is one setting (device, browser, task, pool, endpoint, threads) run several times in one session; its median is what is judged. It is not a sync time: there is no wallet database here. It is part of Milestone 1 of the Konclave Zcash Community Grants grant ([forum thread](https://forum.zcashcommunity.com/t/58165)). Each stage, guard and refusal is in [docs/protocol-details.md](docs/protocol-details.md).

## How to reproduce

The compiler is the one in `rust-toolchain.toml` (`nightly-2025-06-15`, with `rust-src`, `rustfmt`, `clippy` and the `wasm32-unknown-unknown` target). You need rustup, wasm-pack 0.13.1 and Node 24; Docker for a live row; adb and USB debugging for a phone.

| Target | Command |
|---|---|
| Install the pinned compiler | `rustup toolchain install` |
| Build the wasm, both flavours, and the stamps | `./build.sh` |
| Make the folder of the synthetic corpus | `mkdir -p web/corpus` |
| Make the synthetic corpus the page and the tests read | `cargo run --release --example gen_corpus -- web/corpus/synthetic-10k.bin 156 2 16` |
| Serve the page (no hosted page exists); open `http://localhost:8090/` for a single-thread row or `http://localhost:8090/threads.html` for a threads row | `node scripts/serve.mjs 8090` |
| Reach the page from an Android phone | `adb reverse tcp:8090 tcp:8090` |
| Reach the pipeline proxy from an Android phone, for the port of the origin you use in `web/endpoints.mjs` | `adb reverse tcp:<port> tcp:<port>` |
| Start the pipeline proxy for a live row (its rows are never a verdict; without an endpoint the page replays the synthetic corpus) | `docker compose -f proxy/compose.yml up -d` |
| Make the folder for your results, then save each "Copy all" from the page as a `.json` file in it | `mkdir -p my-results` |
| Recompute every median and verdict from raw JSON | `node scripts/summarize.mjs my-results --commit <commit>` |
| Draw the charts from raw JSON | `node scripts/charts.mjs my-results --commit <commit> --out my-results/charts` |
| Rust tests | `cargo test --release` |
| Format check | `cargo fmt --check` |
| Lint | `cargo clippy --all-targets -- -D warnings` |
| Node tests (need the corpus above) | `node --test tests/node.test.mjs tests/charts.test.mjs` |
| Key check of the tree | `node scripts/check-no-keys.mjs` |
| Key check of the history | `node scripts/check-history.mjs` |
| Browser test (local only; needs the build, the corpus, Playwright and Chromium) | `PLAYWRIGHT_MODULE=/path/to/playwright/index.js CHROMIUM=/path/to/chrome node tests/browser.mjs` |

CI (`.github/workflows/ci.yml`) runs the format check, clippy, the Rust tests, the node tests and the two key checks; it does not run the browser test or the wasm build.

The published test key, to scan with in the page, is the `ufvk` of `config/test-vault.json`. The page's fields and link parameters, and one script per scenario that prints the link of each row, are in [docs/protocol-details.md](docs/protocol-details.md).

## Results

No verdict run has been made yet, so the table has no rows. The project's own runs under the protocol go in [results/](results/), as raw JSON. Each row below will name the raw JSON file it is computed from, in this repository, and whether it is a verdict or information. A row from [community-results/](community-results/) is always information, never a verdict. Every number is recomputed from that file by `node scripts/summarize.mjs <folder> --commit <commit>`.

| Device | Browser | Commit | Date | Kind (verdict or information) | Proof (key build + preparation + first proof, `prove-n2`, threads off) | Daily scan (3,456 blocks) | First scan (50,000 blocks) | Raw JSON |
|---|---|---|---|---|---|---|---|---|

Each number is the median of at least 5 counted runs of one session, as `scripts/summarize.mjs` computes it. The bars are in `BARS` in `web/summarize-core.mjs`. The chart of the empty state is `charts/no-verdict-yet.svg`.

## What it does not measure, and known limits

- No wallet database: a number is never a sync time. Sapling is left out, since a vault holds no Sapling key. A synthetic corpus says nothing about a real chain's density.
- A verdict needs the one endpoint of `web/endpoints.mjs` with the role `verdict` (the project's hosted gRPC-web proxy), a range fixed in `web/ranges.mjs`, the published test key, at least 5 counted runs and one session per row. The table names two hosted proxies on Railway, `https://m1-rocks.konclave.xyz` (to `zec.rocks:443`) and `https://m1-global.konclave.xyz` (to `zec.global:443`), and they are the only entries that are verdict-ready. The range heights are `null` today, so the code gives no live row a verdict.
- The verdict device is set by [the thresholds post](https://forum.zcashcommunity.com/t/58165/15), not by the code. The device label is typed by whoever runs the page.
- The first-scan verdict is the 50,000-block row (`first-scan` in `web/ranges.mjs`); the 43.4-day row (`first-scan-43d` in the same table) is information only and never binds a verdict.
- Information only, never a verdict: threads on, the proof alone, the 43.4-day range, a replay of a saved range, a live row on any other endpoint (a local one and the pipeline proxy included), a scan with any key but the published one, a row on a range that is not fixed, and every community result.
- A link can fill the endpoint field only with an origin of the endpoint table in `web/endpoints.mjs`; any other server is typed in by hand, and nothing runs until you tap Run.
- The method end to end (what a verdict is, what is timed, devices, how a run counts, how a community result is sent, the battery method, not yet posted or measured) is in [docs/method.md](docs/method.md).
- The proxy: `allowOrigins` is not access control; any client can call the four routes the proxy allows. The route rules and a rate limit keep it from being an open relay. A proxy sees the address of its callers. The hosted proxies keep no access log. Railway's edge records, for each request, the source IP address, user agent, host, path (without the query string), method, status, byte counts, timings and edge region, for the retention of the plan. We found no setting to turn that off. The pipeline proxy you start from `proxy/` does log: it has `accessLog` on (`proxy/traefik.yml`), so it records each caller's address on your machine. The rate limit of the hosted proxies is keyed on the client address the edge forwards (trusted edge range 100.64.0.0/10). The files and what is and is not proven are in [docs/protocol-details.md](docs/protocol-details.md).
- The published test key, `config/test-vault.json`, is the one viewing key allowed in this repository; `docs/test-vault-key.md` says what it reveals.
- The Content-Security-Policy does not protect against an edited copy of the page.

## How to submit a result

Open a pull request that adds one folder, `community-results/<your GitHub name>/`, with the JSON the page gives you ("Copy all"), unedited, and name in the description the commit you built, the device and the browser. Check it first with `node scripts/summarize.mjs community-results/<you> --commit <commit>` and run `node scripts/check-no-keys.mjs`. The rules and what a result keeps are in [community-results/README.md](community-results/README.md). Commit rules for contributors are in [CONTRIBUTING.md](CONTRIBUTING.md); vulnerabilities go through [SECURITY.md](SECURITY.md).

## Licence and credits

MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`).

Built on crates from the zcash GitHub organisation, at the versions of `Cargo.lock`: orchard 0.16.0 ([zcash/orchard](https://github.com/zcash/orchard)) with halo2_proofs 0.4.0 ([zcash/halo2](https://github.com/zcash/halo2)); zcash_note_encryption 0.5.1 ([zcash/zcash_note_encryption](https://github.com/zcash/zcash_note_encryption)); incrementalmerkletree 0.9.0 and shardtree 0.8.0 ([zcash/incrementalmerkletree](https://github.com/zcash/incrementalmerkletree)); zcash_address 0.14.0 and zcash_protocol 0.11.0 ([zcash/librustzcash](https://github.com/zcash/librustzcash)). zcash_client_backend 0.25.0 and zcash_primitives 0.31.0, also from librustzcash, are used in tests only. orchard depends on reddsa 0.6.1 from the Zcash Foundation ([ZcashFoundation/reddsa](https://github.com/ZcashFoundation/reddsa)). The other direct dependencies are prost, sha2, rand, wasm-bindgen, getrandom (wasm build only), and rayon and wasm-bindgen-rayon (threads build only).

- The method follows ChainSafe's [zcash-wasm-benchmark](https://github.com/ChainSafe/zcash-wasm-benchmark) ([report](https://blog.chainsafe.io/investigating-a-zcash-web-wallet/)). It declares no licence, so none of its code is here.
- The proxy configuration is adapted from [red-dev-inc/WebZjs](https://github.com/red-dev-inc/WebZjs) `traefik/` at `c0457174` (MIT OR Apache-2.0, Copyright (c) 2024 ChainSafe Systems); its licence text is in `THIRD-PARTY-NOTICES`.
- The presentation (charts, a community results folder, a flags table, one script per case) follows [dismad/cbb](https://github.com/dismad/cbb), which declares no licence, so none of its code or text is here.
