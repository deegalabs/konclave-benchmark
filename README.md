# konclave-benchmark

What scanning and proving cost in a browser, on phones and a laptop, timed stage by stage. It is not a sync time: there is no wallet database here.

It is part of Milestone 1 of Konclave's Zcash Community Grants grant ([forum thread](https://forum.zcashcommunity.com/t/58165)). Native mobile wallets already scan and prove; the open question here is the cost inside a phone's browser, where the Konclave app ([private, collective FROST vaults on Zcash](https://github.com/deegalabs/konclave)) runs. A row is one setting (device, browser, task, pool, endpoint, threads) run several times in one session; its median is what is judged.

Work in progress. No verdict run has been made yet, and nothing below is a result.

## Verdict charts

![No verdict run yet](charts/no-verdict-yet.svg)

One chart per device is drawn here once the verdict runs exist: the proof (proving key build, circuit preparation and the first proof, threads off) and the scan (the daily range of 3,456 blocks, the first-scan range of 50,000 blocks), each against its bar, with the bar drawn as a line so a pass or a fail shows at a glance (a row that failed because runs were missing or killed is drawn as that reason, with no time). Which device carries the verdict is set by [the thresholds post](https://forum.zcashcommunity.com/t/58165/15), not by the code: the Galaxy A72 for the proof and both scans, and the laptop for the proof. The Galaxy A14 and S24 Ultra are drawn against the same bars and reported as they are, pass or fail. The code gives a pass or a fail to any row of class phone, and the device label is typed by whoever runs the page, so the report names the device and the chart of another phone is not the verdict. The bars are the ones in `BARS` in `web/summarize-core.mjs`.

The charts are made by `scripts/charts.mjs` from result files and by nothing else. A row is drawn only when the summary (`web/summarize-core.mjs`, the same code the page and `scripts/summarize.mjs` use) gives it a pass or a fail; a row it refuses, calls short, or calls "not a verdict" is not drawn, and each chart says how many rows of the report were left out. The picture above is the script's output on an empty results folder. A test checks that it is. No chart here is ever filled from a smoke run or drawn by hand.

### What counts for the verdict, and what does not

Counts, as the code decides it:
- **Proof:** the wait a member has, key build plus circuit preparation plus the first proof, summed, with threads off, on the 2-output Ironwood row (`prove-n2`), cold (the key is built in the page every run) and verified. The bar is per device class: 180 s for a phone, 90 s for a laptop.
- **Scan:** a live row on the daily range (3,456 blocks, bar 30 s) or the first-scan range (50,000 blocks, bar 10 min), threads off, device class phone (the verdict phone is the A72). A laptop scan row has no bar in the code.
- **The endpoint:** the one endpoint of the table in `web/endpoints.mjs` with the role `verdict`, which is our hosted gRPC-web proxy. A browser cannot call the light client servers directly (they send no CORS headers for gRPC-web, checked 2026-11-09), so every live row goes through a proxy, and its latency is published beside the results (see "Proxy overhead").
- **The range:** fixed in `web/ranges.mjs` and published before any verdict run.
- **The key:** the published test key only (`config/test-vault.json`).
- **At least 5 runs counted per row, and one session per row.** A run that started hot (over 35 C, or over 2 C above the first reading of its session), with the page hidden, or with no readable temperature is kept out of the median.

Information only, never a verdict: threads on; the proof alone (printed beside the sum); the 43.4-day range; a replay of a saved range; a live row on any other endpoint, a local one and our pipeline proxy included; a scan with any key but the published one; a row on a range that is not fixed. A row of device class "other" is refused where a phone or a laptop would have a bar, so it cannot hide a fail.

The endpoint and the range are not filled in yet, and the repository says so rather than guess: the hosted proxy has no host name in the table, and the range heights are `null` in `web/ranges.mjs`. While they are, the code gives no live row a verdict. They are filled before the first verdict run, and no verdict run is made before the objection window of the thresholds post ([forum topic 58165, post #15](https://forum.zcashcommunity.com/t/58165/15)) closes at the end of 16 November 2026 (UTC). If an objection changes a threshold, the code and this README change before any verdict run. A proof row needs neither: holding proof verdict runs until the window closes is our commitment, not a check in the code.

The thresholds are the ones proposed in that post: the application's 1,150 daily blocks assumed 75-second blocks, and NU7 set 25 seconds in November 2026, so a day is now 3,456 blocks. The viewing key and the exact range were promised in [post #17](https://forum.zcashcommunity.com/t/58165/17).

Not judged by this harness: storage (bar 50 MB, reported with the note count) is read from the candidate wallet library and reported apart; battery has no bar, and its method will be posted on the forum for confirmation before any battery measurement. Stability (the tab must not be killed during the proof) does show here: a killed run makes its row FAIL.

## Reproduce it

Before the first verdict run, this repository will hold everything needed to repeat it under the same conditions. Today the key, the heights and the hosted proxy are still empty (see above). A run you make is informative, never a verdict (see "Community results"). The grant's acceptance check is a run of this kind: a reviewer chosen by ZCG, or any committee member, opens the benchmark on an Android phone or a laptop that is not ours and gets the same order of magnitude for that class of device.

- **The test vault's viewing key** is in `config/test-vault.json` (`ufvk`, in full), with its `birthday` and its address. It is a 2-of-3 vault made only for this benchmark, with a small balance, and the one viewing key allowed in this repository; `web/test-vault.mjs` holds the sha256 of that key (`TEST_KEY_SHA256`), so only scans with it keep their amounts. `docs/test-vault-key.md` says what a published viewing key reveals.
- **The exact block ranges**, start and end height of the daily range and the first-scan range, will be in the `RANGES` table in `web/ranges.mjs` (the 43.4-day range, information only, is in it too). The heights are `null` today; they are written before the first run.
- **The endpoint table**, `web/endpoints.mjs`: each origin, what it reaches, its role, and the sha256 of the proxy's files, which you can recompute with `sha256sum`. The proxy's files are `proxy/compose.yml`, `proxy/traefik.yml` and `proxy/conf/dynamic.yml` (and `proxy/testnet/` for the testnet).
- **The commands.** You need a computer with rustup, wasm-pack and Node, and an Android phone with USB debugging on; the page is served from the computer and reached through `adb reverse`. There is no hosted page.
```
./build.sh                                                   # tested with wasm-pack 0.13.1; rust-toolchain.toml names the compiler for both flavours
mkdir -p web/corpus
cargo run --release --example gen_corpus -- web/corpus/synthetic-10k.bin 156 2 16
node scripts/serve.mjs 8090
```
Open `http://localhost:8090/`. On a phone: `adb reverse tcp:8090 tcp:8090`. `threads.html` turns on the threads flavour and isolates itself with a service worker. Served as above (without `--isolated`), `index.html` is not isolated and refuses a threads run. The scenario scripts below print the exact link for each row.

Save what the page shows ("Copy all") into a `.json` file in a folder, then recompute every median and verdict from the raw JSON:
```
node scripts/summarize.mjs results --commit <the commit the report names>
node scripts/charts.mjs results --commit <the commit the report names> --out charts
```
`--commit` is required: without it the build stamps cannot be checked, and the script prints no verdict and exits 2. `--session <id>` names the session that carries the verdict when a row has runs from more than one (see the flags table).

## Community results

Results from your own device can be added by pull request under `community-results/<contributor>/`, as the JSON the page gives you. They are **informative only**. The verdict is only the project's own runs under the protocol. How to send one, and what is kept, is in [community-results/README.md](community-results/README.md).

## What it measures

- **Proving:** the Orchard Action circuit of orchard 0.16.0, for the Ironwood or the Orchard pool, for N outputs. Key build, circuit preparation, proof and verify are timed apart; the verdict sums key build, preparation and first proof.
- **Scanning, by stage:** the download on a live row; decode; trial decryption with the internal and the external viewing key across both pools (this stage also builds the set of spent nullifiers, as a wallet does); and the note commitment trees. Witnesses are timed apart and kept out of the total, since a wallet computes them when it spends.
- **A projection line** beside each scan row (trial decryption in actions per second, actions and compact bytes per block). It carries no pass or fail.

It does not measure a wallet database, so a number here is never a sync time. Storage comes from a candidate wallet library, not from this harness. Sapling is left out on purpose: a vault holds no Sapling key, and a wallet that has one costs more. A synthetic corpus says nothing about a real chain's density.

[docs/protocol-details.md](docs/protocol-details.md) has each stage, each guard and each refusal in full.

## Fields and flags

Page fields, with the link parameter that fills them (a link only fills the form: nothing runs until you tap Run, and a link never carries a viewing key):

| Page field | Link parameter | Default | Accepted in a link / limit |
|---|---|---|---|
| Device (model and RAM) | `device` | empty | up to 80 characters (`TEXT_LIMITS.device_label`) |
| Device class | `class` | none chosen | `phone`, `laptop`, `other` |
| Temperature | none | empty | up to 16 characters (`TEXT_LIMITS.temp_before`) |
| On the charger | none | off | |
| Runs per row | `runs` | 5 | 1 to 999 |
| Threads | `threads` | `off` | `on`, `off` |
| Thread count | none | empty (the device's) | up to 3 characters |
| Prove | `prove` | on | `1`, `on`, `true`, `yes`, `0`, `off`, `false`, `no` |
| Pool | `pool` | `ironwood-v3` | `ironwood-v3`, `orchard-v2` |
| Outputs | `outputs` | `2` | digits, comma separated, up to 40 characters |
| Scan | `scan` | off | as Prove |
| This range is | none | `other` (the heights typed) | `daily`, `first-scan`, `first-scan-43d`, or `other`; pick it in the page |
| Saved range | `corpus` | `synthetic-10k.bin` | a file name in `web/corpus`, up to 80 characters |
| Live endpoint | `endpoint` | empty (no network) | only an origin of the endpoint table; up to 200 characters if typed |
| Live range, first and last height | `start`, `end` | empty | up to 10 digits |
| Viewing key | none, never | empty (the synthetic key) | the published test key only counts |
| Skip transactions over N actions | none | empty (none) | up to 10 characters; a filtered row is refused |

The free-text limits are `TEXT_LIMITS` in `web/summarize-core.mjs` and `FORM_LIMITS` in `web/plan.mjs`; the link rules are in `web/prefill.mjs`. A record with a field over its limit is refused with that reason.

`scripts/summarize.mjs <results dir>`:

| Flag | Meaning |
|---|---|
| `--commit <commit>` | Required. The commit the report names; a result whose wasm or page script is not that commit is refused, and the script exits 1. |
| `--session <id>` | Optional, repeatable. Names the session that carries the verdict when a row has runs from more than one. `--session '<row or group>=<id>'` names it for one row. The page makes a new session id each time it loads. |

`scripts/charts.mjs` takes the same `--commit` (required) and `--session`, plus `--out <folder>` (default `charts`) and `--only prove|daily|first-sync`.

## One script per scenario

Each prints the link of the page with its parameters; given `--results <folder> --commit <commit>` it also writes `<out>/<scenario>.json` (the summary rows of that scenario) and the chart. The page is what runs the prove and scan scenarios: a script does not pretend to drive a browser.

| Scenario | Script | Writes |
|---|---|---|
| Prove (key build + circuit preparation + first proof, threads off) | `node scripts/scenario-prove.mjs` | `prove.json`, one `.svg` per device |
| Daily scan (3,456 blocks) | `node scripts/scenario-daily.mjs` | `daily.json`, one `.svg` per device |
| First scan (50,000 blocks) | `node scripts/scenario-first-scan.mjs` | `first-scan.json`, one `.svg` per device |
| Proxy overhead | `node scripts/scenario-proxy-overhead.mjs` | `proxy-overhead.json`, `proxy-overhead.svg` |

The options are `--device <label>`, `--class phone|laptop|other`, `--endpoint <origin of the table>`, `--results <folder>`, `--commit <commit>`, `--session <id>` and `--out <folder>`. There is no link parameter for the range, so the daily and first-scan scripts tell you which range to pick in the page. Without an `--endpoint` the page replays the saved corpus, which is never a verdict.

### Proxy overhead

`node scripts/scenario-proxy-overhead.mjs --entry <origin of the table> --range <start>-<end> --read-approved [--runs N] [--out folder]` runs `scripts/proxy-latency.mjs` and draws what it wrote: the proxied path minus a direct path, per call, measured from the host it runs on. It reads the chain, so it refuses to run without `--read-approved`. It is not the phone's radio or ISP path or the browser's own fetch cost; for a hosted proxy the honest figure is the same script run from a machine on the phone's network. `--from <json>` draws an output you already have and reads nothing. This chart is information, never a verdict. Live times include the proxy and are never corrected for it.

## Guards

A run does not count when it fails any of these (the details and the reasons the report prints are in [docs/protocol-details.md](docs/protocol-details.md)): the build is a clean commit and the wasm and the page script match the stamps `build.sh` wrote; the proof verified and was cold; the stages add up to the time that ran; the page was not hidden; the run started cool; the thread pool is the size asked and the page isolated; the endpoint, the range and the key are the ones the protocol names; and a verdict live row carries what the server said (chain name `main`, tree states, end block hash). The page uploads nothing: results leave only when you copy them. A result never stores any part of a viewing key typed in, only the sha256 of its text. Both key checks were run on 2026-11-10, on a fresh clone, with no hit, and are run again at the commit that is made public: `node scripts/check-no-keys.mjs` on a fresh clone (`git clone . /tmp/kb-fresh && node scripts/check-no-keys.mjs /tmp/kb-fresh`) and `node scripts/check-history.mjs`.

The Content-Security-Policy lets the page reach only its own origin, any https host (the endpoint you may type is arbitrary) and plain http on this machine (`localhost` and `127.0.0.1`, for the pipeline proxy). It does not protect against an edited copy of the page.

## The gRPC-web proxy

The proxy is Traefik (v3.7, pinned by digest) with the `grpcWeb` middleware and a `rateLimit` middleware, file provider only, no docker socket, dashboard or API. `allowOrigins` is not access control: what stops a hosted proxy from being an open relay is that its routers allow only the four calls the harness makes and the rate limit. The files, the table that hashes them, what a run observes of the upstream, and what is and is not proven about where the proxy forwards are in [docs/protocol-details.md](docs/protocol-details.md). A proxy you start from `proxy/` is the pipeline proxy and its rows read "pipeline proxy, not a verdict". The hosted proxy for verdict runs is not deployed yet; its files and hashes are published here when it is.

## Tests

The node tests read the synthetic corpus `web/corpus/synthetic-10k.bin` when they load, and it is not in the repository (`/web/corpus` is ignored): on a fresh clone make it first, with the `mkdir` and `gen_corpus` lines of "Reproduce it", or `node --test tests/node.test.mjs` fails before its first test. The charts and scenario tests need no corpus.
```
cargo test --release
node --test tests/node.test.mjs
node --test tests/charts.test.mjs
PLAYWRIGHT_MODULE=.../playwright/index.js CHROMIUM=.../chrome node tests/browser.mjs
```
The browser test talks only to servers it starts on this machine. The routes and the rate limit of the proxy files committed here (Traefik v3.7) were checked against a container of the pinned image with a dead local upstream, with no network (see docs/protocol-details.md). An earlier version of them (Traefik v3.1, before the route limits and the rate limit) was run on 2026-11-09 against `testnet.zec.rocks`, together with `scripts/proxy-latency.mjs`, and checked by hand through `zec.rocks` and `zec.global` (a CORS preflight and one `GetLatestBlock` call each).

See [CONTRIBUTING.md](CONTRIBUTING.md): a result is never edited by hand, and a new check comes with a test that fails without it.

## Licence

MIT or Apache-2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`).

## Credits

- The method follows ChainSafe's [zcash-wasm-benchmark](https://github.com/ChainSafe/zcash-wasm-benchmark), published in 2024 ([report](https://blog.chainsafe.io/investigating-a-zcash-web-wallet/)). The grant application said this benchmark would start from that one; it declares no licence, so this repository contains none of its code.
- The proxy configuration is adapted from [red-dev-inc/WebZjs](https://github.com/red-dev-inc/WebZjs) `traefik/` at `c0457174` (MIT OR Apache-2.0, Copyright (c) 2024 ChainSafe Systems), with credit in each file's header and its licence text in `THIRD-PARTY-NOTICES`.
- The presentation (charts at the top with a short note under them, a community results folder, a flags table, one script per case) is an idea taken from [dismad/cbb](https://github.com/dismad/cbb). cbb declares no licence, so no code or text of it is here.
