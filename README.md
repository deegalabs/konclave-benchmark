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

Milestone 1 runs, build `37aa10f`, raw page exports in [results/m1/](results/m1/) (unedited; each file is one browser's export and may hold several sessions). Every number is recomputed with `node scripts/summarize.mjs results/m1 --commit 37aa10f`; a row whose file holds more than one session of the same row needs `--session <full session id>`, one command per row (short ids do not match). A **verdict** is only a row the protocol names (A72 Firefox through `m1-rocks`, the laptop proof in Chrome, first session of 17 November 2026, see [docs/method.md](docs/method.md#what-is-fixed-before-the-runs)); a **bar row** is another named phone against the same bar; everything else is **information**.

Dates are UTC. "AC" means the room's air conditioning was on. The temperature rule: a run counts only if the phone's own reading at its start is at most 35 °C and at most 2 °C above the session's first reading. Where the temperature typed in the page went stale, the host log (adb, time and temperature only, [results/m1/host-temperature-extract.json](results/m1/host-temperature-extract.json) and `results/m1/host-log-*.log`) is shown beside the printed result, and a stale row never supports a pass unless the host log agrees.

| Device | Browser | Row (bar) | Kind | Result | Session (full id) | Conditions |
|---|---|---|---|---|---|---|
| A72 6GB | Firefox 160 | proof (180 s) | verdict | **PASS** 89.68 s, 5/5 (the typed field stayed at 32.8 °C; host readings just after the starts 33.1, 33.6, 34.0, 34.5, 35.0 °C: run 5 starts at the 35.0 °C ceiling and within 2 °C of the first host reading, so the host log agrees, with no margin; with the typed 32.8 °C as the first reading it would not; runs 89.58-89.76 s) | 84b795a0-f46f-4741-a124-ecad1e5d2ac7 | 17/11, "On the charger" ticked; AC not recorded |
| A72 6GB | Firefox 160 | one day (30 s) | verdict | **FAIL** 127.74 s, 5/5 | ad4f402f-97ff-45b2-a86e-c066345da873 | 17/11, off charger; AC not recorded |
| A72 6GB | Firefox 160 | first scan (600 s) | verdict | short, 2 of 5 counted (hot starts; one run page-hidden); all runs over 600 s | d10969e7-a80d-462d-bb24-4b9ead10dc5d | 17/11, off charger; AC not recorded |
| Dell G7 24GB | Chrome 157 | proof (90 s) | verdict | **PASS** 43.84 s, 5/5 | 51faa818-1037-47b5-aae0-f4345c931145 | 17/11, on the charger (`charging: true`) |
| A14 4GB | Firefox 160 | proof (180 s) | bar row | **FAIL** 248.63 s as printed (stale field; host log would exclude runs 3-5; every run 248.4-248.9 s) | c33ea3fc-632b-4b48-b072-e4c8888325ba | 18/11, off charger; AC not recorded |
| A14 4GB | Firefox 160 | one day (30 s) | bar row | short, 2 of 5 (hot starts); runs 384.8-389.6 s | e656b0ab-ffa7-4731-8c05-6c1537ff76fa | 19/11 afternoon, no AC, alone |
| A14 4GB | Firefox 160 | first scan (600 s) | bar row | **FAIL** 2,687.53 s, 5/5 | e656b0ab-ffa7-4731-8c05-6c1537ff76fa | 19/11 evening, AC on, concurrent with other phones (download inflated; cannot change the result) |
| S24 Ultra 12GB | Firefox 160 | proof (180 s) | bar row | short, 3 of 5 (hot starts); counted runs 25.54-28.44 s | fbb75131-be1b-4a8b-baf7-a070888693ea | 19/11, off charger |
| S24 Ultra 12GB | Firefox 160 | one day (30 s) | bar row | SHORT by the rule (3 of 5 runs within the temperature rule, host log `host-log-s24-2026-11-20-b.log`: 28.1, 28.3, 29.0, 30.3, 30.8 °C at the starts); all 5 runs over the 30 s bar (38.59 to 40.22 s); printed: FAIL 39.77 s with all 5 counted (the typed field stayed at 30.6 °C) | ba4074b6-7fb7-4d60-8a2c-6f8cd2058a68 | 20/11, alone, **AC on** (the no-AC condition could not be held, room warm), off charger |
| S24 Ultra 12GB | Firefox 160 | first scan (600 s) | bar row | no verdict: printed pass 269.29 s with `--session`, not claimed (stale field; on the host log runs 2-5 start over the limit); every run 262-275 s | 89309ca0-1ba3-4f59-b98f-ac84d1f68c3c | 19/11, AC on, concurrent with the A14 |
| Dell G7 24GB | Chrome 157 | one day | information (no laptop scan bar) | 59.74 s (10 runs, the row was run twice in one session) | dae9fe2a-3242-4370-9a29-9c9b2f0e9509 | 20/11, charger on |
| Dell G7 24GB | Chrome 157 | first scan | information | 388.78 s, 4 counted (one page-hidden) | dae9fe2a-3242-4370-9a29-9c9b2f0e9509 | 20/11, charger on |
| Dell G7 24GB | Firefox 160 | proof | information | 40.90 s, 5/5 | 5446a2aa-9be7-4482-b7bb-176f8ae97cb0 | 20/11, charger on, Firefox installed for the row |
| A72 6GB | Chrome 157 | proof | information | 88.72 s, 5/5 | 6f51f58a-4f61-4687-a84a-67b5ca00718a | 18/11, off charger |
| A72 6GB | Chrome 157 | one day | information | 125.58 s, 5/5 | 2c40a105-7f0e-461b-b01f-86164e2650c8 | 18/11 |
| A72 6GB | Firefox 160 | one day via `m1-global` | information | 125.66 s, 5/5 | fff15dbc-0fe2-46f3-8acc-352571a7a28a | 18/11 |
| A72 6GB | Chrome 157 | first scan | information | 897.86 s, 5/5 | 7aed8fd1-30c0-42e7-9ef6-e778b0bf8643 | 19/11, AC on, concurrent with the A14 (download 82.6 s) |
| A72 6GB | Chrome 157 | first scan via `m1-global` | information | printed FAIL (run 5 missing): runs 1-4 866-961 s, only run 1 within the temperature rule; run 5 failed to start (our operator notes: the adb server restarted) | a114249b-c5aa-46a4-8618-f9c2b1f91698 | 20/11, AC on |
| A72 6GB | Chrome 157 | first scan, per-block tree | information | 1,066.08 s, 1 run (tree 1.52x the chunked tree) | af5508d1-d7bf-4af0-9e70-c0267be3e081 | 20/11, AC on, alone |
| A72 6GB | Chrome 157 | 43.4 days (150,000 blocks) | information | 3,830.87 s, 1 run | 6dca0720-a836-40d2-8b0f-e9ab92312a7d | 20/11, AC on, alone |
| A72 6GB | Chrome 157 | one day direct to `https://zec.global` (no proxy) | information | 126.17 s, 5/5 | 21baeae3-7c73-4333-8fbf-f07c301b6edf | 20/11, AC on, alone |
| A72 6GB | Chrome 157 | threads on: proof, 4 threads | information | 54.37 s (single-thread build 88.72 s) | 36468006-661a-433b-a825-4a2d2f9d2a0d | 20/11, AC on; threads page with the missing tree-insert control added (see below) |
| A72 6GB | Chrome 157 | threads on: one day via `zec.global`, 4 threads | information | 92.37 s (1 thread 126.15 s; decrypt 2.4x faster, tree stage unchanged) | 36468006-661a-433b-a825-4a2d2f9d2a0d | 20/11, AC on |

Sessions listed but not counted: S24 one day 673d49fc-4085-4d40-85a6-b80314d6e8d6 (40.27 s, 5/5, run while the A14 used the same proxy and Wi-Fi: a disclosed note, not the bar row); A72 Chrome proof 68686726 (killed at run 1 by a page reload the operator caused); A72 Chrome first scan c503ad96-73cb-4f21-9f8e-df84aa952463 (stopped at run 1); A72 per-block 09ea3bcf-c7e5-4005-ab86-c4a202944587 (network error); S24 first scan 673d49fc-4085-4d40-85a6-b80314d6e8d6 (refused: time no stage accounts for); S24 one day b443e05a-f0dc-478a-9c47-e5a658788952 (refused: more runs than planned, temperature not recorded); Dell 13318cdd-74b7-4b95-9d82-feb0296c115c (first scan: temperature empty on all runs; one day: the key field did not hold the published key). Smoke and rehearsal sessions from 9, 11, 12 and 16 November are in the files and are refused by the summary as another commit.

Commands for the rows that share a file with another session of the same row:

```
node scripts/summarize.mjs results/m1 --commit 37aa10f --session ba4074b6-7fb7-4d60-8a2c-6f8cd2058a68
node scripts/summarize.mjs results/m1 --commit 37aa10f --session 89309ca0-1ba3-4f59-b98f-ac84d1f68c3c
node scripts/summarize.mjs results/m1 --commit 37aa10f --session 6f51f58a-4f61-4687-a84a-67b5ca00718a
node scripts/summarize.mjs results/m1 --commit 37aa10f --session 7aed8fd1-30c0-42e7-9ef6-e778b0bf8643
node scripts/summarize.mjs results/m1 --commit 37aa10f --session dae9fe2a-3242-4370-9a29-9c9b2f0e9509
```

Storage (information, not a verdict row: measured in headless desktop Chromium with WebZjs PR #27, method fixed in an internal run sheet and not published before): a 12-month projection of 86.8 MB serialized / 57.3 MB IndexedDB against the 50 MB bar, computed as the test vault as measured (1.96 MB / 1.28 MB for 27,182 blocks and 2 notes, run 3558848) plus 12 months of new blocks (1,261,440 at 25 s) times the per-block growth between the shortest and longest runs (67.23 B / 44.44 B per block, runs 3558848 and 3500000) ([results/m1/storage/](results/m1/storage/)). The per-block action count of the one-day range is [results/m1/daily-perblock-actions.json](results/m1/daily-perblock-actions.json) (153 blocks with more than 250 actions hold 78.9% of its 58,622 actions).

The bars are in `BARS` in `web/summarize-core.mjs`. The charts for these rows are drawn by the scenario scripts; on a folder with no verdict they draw `charts/no-verdict-yet.svg`.

**A public endpoint with no proxy.** `https://zec.global`, run by Zingo Labs, answered gRPC-web to a browser page on another origin when tested on 20 November 2026 from 17:50 UTC (row 21baeae3 above). A reviewer can point the page at it directly for the one-day row, as information: it is not a verdict endpoint in `web/endpoints.mjs`. Zingo Labs reports that zec.global has been validated with up to 16k concurrent scanning wallets (their statement, not our measurement). The verdict path stays the project's two proxies, kept up until the independent review is published.

**Threads.** At `37aa10f`, `web/threads.html` lacks the "Tree stage inserts" control the page script reads, so Run does nothing on the threads page. The threads rows above were run from that page with the one control added (the page script and wasm stamps are unchanged, `37aa10f`; the stamp does not cover the HTML), served with `node scripts/serve.mjs <port> --isolated`, since the service worker did not isolate the page in Chrome on the phone. The hosted proxies refuse that page's origin, so the threads one-day row ran through `zec.global`, and so did its single-thread control.

## What it does not measure, and known limits

- No wallet database: a number is never a sync time. Sapling is left out, since a vault holds no Sapling key. A synthetic corpus says nothing about a real chain's density.
- A verdict needs a live row through an endpoint of `web/endpoints.mjs` with the role `verdict` (the project's hosted gRPC-web proxies), a range fixed in `web/ranges.mjs`, the published test key, at least 5 counted runs and one session per row. The table names two hosted proxies on Railway, `https://m1-rocks.konclave.xyz` (to `zec.rocks:443`) and `https://m1-global.konclave.xyz` (to `zec.global:443`), and they are the only entries that are verdict-ready; the project reports the row through `m1-rocks` as the verdict and the other as information. The range heights were fixed on 17 November 2026 (T = 3,580,868, see [docs/method.md](docs/method.md#what-is-fixed-before-the-runs)).
- The browser, the endpoint, the range heights and the session that carry the verdict runs of 17 November 2026 are fixed before them: [docs/method.md](docs/method.md#what-is-fixed-before-the-runs).
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
