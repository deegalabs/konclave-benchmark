# konclave-benchmark

## What it measures

This is a measurement harness for what scanning and proving cost inside a browser, on phones and a laptop, timed stage by stage. It proves with the Orchard Action circuit of orchard 0.16.0 (key build, circuit preparation, proof and verify timed apart) and scans compact blocks (download, decode, trial decryption with the internal and the external viewing key across both pools, and the note commitment trees), timing witnesses apart. A row is one setting (device, browser, task, pool, endpoint, threads) run several times in one session; its median is what is judged. It is not a sync time: there is no wallet database here. It is part of Milestone 1 of the Konclave Zcash Community Grants grant ([forum thread](https://forum.zcashcommunity.com/t/58165)). Each stage, guard and refusal is in [docs/protocol-details.md](docs/protocol-details.md).

## How to reproduce

The compiler is the one in `rust-toolchain.toml` (`nightly-2025-06-15`, with `rust-src`, `rustfmt`, `clippy` and the `wasm32-unknown-unknown` target); `rustup toolchain install` (run in the repository) installs it. You need rustup, wasm-pack 0.13.1 and Node 24.

| Target | Command |
|---|---|
| Build the wasm, both flavours, and the stamps | `./build.sh` |
| Make the synthetic corpus the page and the node tests read | `mkdir -p web/corpus && cargo run --release --example gen_corpus -- web/corpus/synthetic-10k.bin 156 2 16` |
| Serve the page (no hosted page exists) | `node scripts/serve.mjs 8090` |
| Reach the page from an Android phone | `adb reverse tcp:8090 tcp:8090` |
| Recompute every median and verdict from raw JSON | `node scripts/summarize.mjs results --commit <commit>` |
| Draw the charts from raw JSON | `node scripts/charts.mjs results --commit <commit> --out charts` |
| Rust tests | `cargo test --release` |
| Format and lint | `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` |
| Node tests (need the corpus above) | `node --test tests/node.test.mjs tests/charts.test.mjs` |
| Key checks | `node scripts/check-no-keys.mjs` and `node scripts/check-history.mjs` |
| Browser test (local only; needs Playwright and Chromium) | `PLAYWRIGHT_MODULE=.../playwright/index.js CHROMIUM=.../chrome node tests/browser.mjs` |

CI (`.github/workflows/ci.yml`) runs the format check, clippy, the Rust tests, the node tests and the two key checks; it does not run the browser test or the wasm build.

## Results

No verdict run has been made yet, so the table has no rows. Rows are added from the raw JSON files in [community-results/](community-results/) and from the project's own runs, with the numbers recomputed by `scripts/summarize.mjs`.

| Device | Browser | Commit | Date | Proof (key build + preparation + first proof, threads off) | Daily scan (3,456 blocks) | First scan (50,000 blocks) |
|---|---|---|---|---|---|---|

The proof and scan columns are the medians of at least 5 counted runs of one session, as `scripts/summarize.mjs` computes them. The bars are in `BARS` in `web/summarize-core.mjs`. The chart of the empty state is `charts/no-verdict-yet.svg`.

## What it does not measure, and known limits

- No wallet database: a number is never a sync time. Sapling is left out, since a vault holds no Sapling key. A synthetic corpus says nothing about a real chain's density.
- A verdict needs the one endpoint of `web/endpoints.mjs` with the role `verdict` (the project's hosted gRPC-web proxy), a range fixed in `web/ranges.mjs`, the published test key, at least 5 counted runs and one session per row. The hosted proxy has no host name in the table and the range heights are `null` today, so the code gives no live row a verdict.
- The verdict device is set by [the thresholds post](https://forum.zcashcommunity.com/t/58165/15), not by the code. The device label is typed by whoever runs the page.
- Information only, never a verdict: threads on, the proof alone, the 43.4-day range, a replay of a saved range, a live row on any other endpoint (a local one and the pipeline proxy included), a scan with any key but the published one, a row on a range that is not fixed, and every community result.
- The proxy: `allowOrigins` is not access control; the routes and the rate limit are. A proxy sees the address of its callers. The files and what is and is not proven are in [docs/protocol-details.md](docs/protocol-details.md).
- The published test key, `config/test-vault.json`, is the one viewing key allowed in this repository; `docs/test-vault-key.md` says what it reveals.
- The Content-Security-Policy does not protect against an edited copy of the page.

## How to submit a result

Open a pull request that adds one folder, `community-results/<your GitHub name>/`, with the JSON the page gives you ("Copy all"), unedited, and name in the description the commit you built, the device and the browser. Check it first with `node scripts/summarize.mjs community-results/<you> --commit <commit>` and run `node scripts/check-no-keys.mjs`. The rules and what a result keeps are in [community-results/README.md](community-results/README.md). Commit rules for contributors are in [CONTRIBUTING.md](CONTRIBUTING.md); vulnerabilities go through [SECURITY.md](SECURITY.md).

## Licence and credits

MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`).

Built on the Zcash Foundation and librustzcash crates, at the versions of `Cargo.lock`: orchard 0.16.0 (with its halo2_proofs 0.4.0), zcash_note_encryption 0.5.1, incrementalmerkletree 0.9.0, shardtree 0.8.0, zcash_address 0.14.0 and zcash_protocol 0.11.0; zcash_client_backend 0.25.0 and zcash_primitives 0.31.0 are used in tests only. Other dependencies are prost, sha2, rand, wasm-bindgen, rayon and wasm-bindgen-rayon.

- The method follows ChainSafe's [zcash-wasm-benchmark](https://github.com/ChainSafe/zcash-wasm-benchmark) ([report](https://blog.chainsafe.io/investigating-a-zcash-web-wallet/)). It declares no licence, so none of its code is here.
- The proxy configuration is adapted from [red-dev-inc/WebZjs](https://github.com/red-dev-inc/WebZjs) `traefik/` at `c0457174` (MIT OR Apache-2.0, Copyright (c) 2024 ChainSafe Systems); its licence text is in `THIRD-PARTY-NOTICES`.
- The presentation (charts, a community results folder, a flags table, one script per case) follows [dismad/cbb](https://github.com/dismad/cbb), which declares no licence, so none of its code or text is here.
