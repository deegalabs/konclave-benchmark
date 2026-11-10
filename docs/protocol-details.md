# Protocol details

The long form of what the README summarises, followed by the verdict rules, the fields and flags and the scenario scripts: what each stage times, what keeps a run out of the median, what makes a row a verdict or not, and the gRPC-web proxy. It describes the code at this commit; when the two differ, the code is right and this is a bug.

## What each row times
- **Proving:** the Orchard Action circuit of orchard 0.16.0, for the Ironwood or the Orchard pool, for N outputs. Key build and proof are timed apart; the key is built in the page, every run.
- **The proof verdict** is the wait a member has: key build, circuit preparation and the first proof (the bundle is built in preparation), summed, with threads off. Preparation is inside on purpose: it takes milliseconds against seconds for the key build and the proof, so counting it errs on the slow side, and every row prints the three apart and the proof alone beside the sum.
- **Scanning, by stage:** a corpus check outside the timer, then decode, trial decryption with the internal and the external viewing key across both pools (this stage also builds the set of spent nullifiers, as a wallet does), and the note commitment trees, plus, on a live row, the tree state before the range, the download and the tree state at its end (the server's `GetLightdInfo` call is outside the timer). Witnesses are timed and kept out of the total, since a wallet computes them when it spends.

Every scan row also prints a `projection (not a verdict)` line: trial decryption in actions per second, actions per block and compact bytes per block (each the median over the runs counted in the row's median, and none on a refused row; the wasm records `compact_bytes` and `compact_bytes_by_block`, the size of the compact block messages as they were pushed). These are rates and sizes of the range that was scanned, to project a larger block later. They carry no pass or fail, are never read by a bar, a verdict or a row key, and say nothing about a block of another density.


## Guards, in detail

The page contacts nothing but its own origin unless a live endpoint is typed in or filled from a link (a link can fill `endpoint` only with an origin of the endpoint table, which the page shows before Run, and nothing runs until you tap Run; any other server is typed in by hand). The page shows each row's result by the same rules as the report (`web/summarize-core.mjs`) and uploads nothing: results leave only when you copy them. `node scripts/summarize.mjs results --commit <the commit the report names>` (`--commit` is required) recomputes every median and verdict from saved results. What keeps the page from sending anything is the published code itself, which you can read: it has no upload, and a test fails if a web source other than `web/endpoints.mjs` (the table of endpoints) names a host. The Content-Security-Policy, as a meta tag on the pages and as a header on workers where the host can set one (the local server, the threads page's service worker), stops injected code from reaching plain-http hosts other than this machine (`localhost` and `127.0.0.1` stay allowed for the pipeline proxy), but it allows any https host, because the light client endpoint you may type is arbitrary. It does not protect against an edited copy of the page. The page says which mode it ran in: not isolated (single thread only), isolated by the server's headers, or isolated by its own service worker.

A run counts only if it starts at or below `HOT_START_ABSOLUTE_C` (35 C) and within `HOT_START_OVER_FIRST_C` (2 C) of the first reading of its session; a hotter run, or one on a verdict row with no readable temperature, is marked and kept out of the median. The page cannot read a battery: it records what is in the temperature field at the start and at the end of each run. `node scripts/battery-log.mjs battery.log` (optional, on the host, with adb) writes the battery level, temperature and charging state every 10 s with the time, so the numbers do not depend on typing.

Build stamps: `build.sh` stamps each wasm build (the commit and the sha256 of its wasm, of its JS glue `konclave_benchmark.js` and of the helper files under `snippets/` that the threads glue imports, in `meta.json`, written by `scripts/stamp-meta.mjs`) and also the page's own script (`web/stamp.json`, the commit and a hash of each script file). The page hashes what it was served and records `js_commit` and `js_files_match` in every result. `node scripts/summarize.mjs results --commit <commit>` refuses a result whose wasm or page script is not that commit, in every row, and exits 1 when one is found; without `--commit` it prints nothing and exits 2. The page compares its own script stamp with the wasm's and will not start a run when they differ. The worker hashes the wasm it was served and refuses it when the hash is not the stamped one; every result records both for the wasm and for the glue (`wasm_sha256`, `wasm_sha256_stamped`, `glue_sha256`, `glue_sha256_stamped`, `snippets_sha256`, `snippets_sha256_stamped`) and the script refuses a result where they differ, so a wasm rebuilt outside `build.sh` cannot run under an earlier stamp. A result whose script and wasm stamps differ is refused with or without `--commit`.

Results saved before the endpoint, `js_commit`, `js_files_match` and `page_hidden_during_run` fields existed (a page built before these guards) carry none of them, and the current summary refuses them on a verdict row. Rerun them with a page built from the report's commit.

The report, on the page and from `scripts/summarize.mjs`, prints only printable text from result files. Free text is short: the page refuses a device, temperature, corpus or other free field over its limit (`FORM_LIMITS` in `web/plan.mjs`), and a record with a longer field (`TEXT_LIMITS` in `web/summarize-core.mjs`, the one table the form and the link read too: device label, temperature, user agent, session, row and endpoint) is refused with that reason. `node scripts/check-no-keys.mjs` scans every folder except build output at a fixed path (run it on a fresh clone, `git clone . /tmp/kb-fresh && node scripts/check-no-keys.mjs /tmp/kb-fresh`: it reads the working tree, and build output that is not in git can hold key-shaped test vectors of a dependency), and `node scripts/check-history.mjs` scans every object reachable from a local ref (every blob, text or binary, every commit and annotated tag message, tags on a blob or a tree, and every entry of the stash, UTF-16 included) for a key, viewing or spending, exiting 1 on a hit (a branch that exists only on the remote, never fetched, is not in the count); run both before the repository is made public.

A result never stores any part of a viewing key typed into the page: the wasm records `key_sha256`, the sha256 of the key text (null for the synthetic key), and nothing else of it. Only the published test key is scanned for a verdict, and a live row scanned with the synthetic key is never a verdict (nothing checks its balance): a live row needs `key_sha256` equal to `TEST_KEY_SHA256` in `web/test-vault.mjs` (the hash of the key in `config/test-vault.json`). The amounts and note counts of a scan (`received_zat`, `spent_in_range_zat`, `found`, `notes`, `witnesses`) are also stored only for the synthetic key or that hash: any other typed key leaves them out.

A live scan row gets a verdict only on a range the protocol fixed: `web/ranges.mjs` holds the daily range (3,456 blocks), the first-scan range (50,000 blocks) and a 43.4-day range that is information only, with heights null until the range is fixed and published. The page chooses the range by its id (daily, first scan, 43.4 days) instead of typed heights, and every run, dead or alive, records the range it was asked for (`range_asked`). A row is judged on that request matched to the table, and each run that ended ok must also have recorded the same `start_height` and `blocks` and the same kind; a run that died keeps its row's bar, so a first scan whose tab dies reads FAIL. Until a range is fixed the page refuses a range picked by id ("the range daily is not fixed by the protocol yet") and a row on typed heights has no bar. A live scan row shows the endpoint's reason first ("pipeline proxy", "local endpoint" or "endpoint not named by the protocol", each "not a verdict"), because no endpoint of the table is verdict-ready yet, and the range's own reason, "range not fixed by the protocol, not a verdict", comes after it: once an endpoint is ready, a row on a range that is not fixed reads that. A row on the 43.4-day range reads "information only, not a verdict". A replay reads "replay, not a verdict".

A verdict also needs an endpoint that the endpoint table (`web/endpoints.mjs`, compared as an origin) names with the role `verdict`. Any other live endpoint is reported with "endpoint not named by the protocol, not a verdict"; a pipeline proxy of ours with "pipeline proxy, not a verdict"; any other server on this machine with "local endpoint, not a verdict". The table is read before the local check. Today the table has no hosted proxy (its verdict entry has no host name), so no live row carries a verdict yet. A result recorded before this table, with a public origin such as `https://zec.rocks` as its endpoint, reads "endpoint not named by the protocol, not a verdict", and `--commit` refuses it on the commit gate. More ok runs than planned in one session is refused. One verdict session per row: when the same row (device, browser, row, pool, endpoint, threads, filter) has verdict-capable runs from more than one session, every one of them is REFUSED "more than one session" until the report names the session that carries the verdict, `node scripts/summarize.mjs results --commit <commit> --session <id>` (one id for every row), or `--session '<row name or group>=<id>'` for one row, repeatable: a row is named by its exact name or its exact group (the row key without the session, as the script prints it on an ambiguous name), never by a prefix, and a name that two rows share is refused; the other sessions stay printed as "not the named session, not a verdict". The page, which cannot name one, shows the refusal.

## The gRPC-web proxy
A browser cannot call `zec.rocks` or `zec.global` directly: they send no CORS headers for gRPC-web (checked 2026-11-09), so a page of this harness reaches a live light client only through a gRPC-web proxy. This is the same reason every browser wallet needs one (WebZjs documents it). The proxy is Traefik (the maintained v3.7 line, pinned by digest) with the `grpcWeb` middleware and a `rateLimit` middleware in front of it, and nothing else is in the path: file provider only, no docker socket, no dashboard, no API, `allowOrigins` limited to the pages that use it (the harness page; on the mainnet pipeline proxy also the WebZjs no-threads test page, which `proxy/conf/dynamic.yml` says in a comment). Its configuration is adapted from [red-dev-inc/WebZjs](https://github.com/red-dev-inc/WebZjs) `traefik/` at `c0457174` (MIT OR Apache-2.0), with credit in each file's header.
- Where: `proxy/compose.yml` (image pinned by digest, ports bound to `127.0.0.1`), `proxy/traefik.yml`, `proxy/conf/dynamic.yml`. `docker compose -f proxy/compose.yml up -d` publishes the pipeline proxy on the origins that `web/endpoints.mjs` lists, each with the upstream it reaches (the table is the one place that says which port reaches which host); on a phone, `adb reverse tcp:<port> tcp:<port>`. `proxy/testnet/` is the same for the testnet upstream, to try the proxy and the scripts before any mainnet read. `.gitattributes` marks `proxy/**` as `-text`, so a checkout cannot change the bytes that are hashed.
- What the table says: for each origin, the upstream it reaches (`upstream`) and the sha256 of each of the three files, which you can recompute with `sha256sum`. A test reads the files (published ports, entry points, routers, services) and checks that the table says the same, and another recomputes the hashes. The upstream is a declaration: a result records it as `upstream_declared` and the hashes as `proxy_config_declared`, from the table. They are not observed and are not part of the row key.
- What a run observes instead: the server's `GetLightdInfo` (version, vendor, chain name, block height), the tree states at the block before the range and at its end (the serialised states the server sent, as hex), the end block hash, and the bare 32-byte note-commitment tree roots of each pool at the start and end of the range (`tree_roots`: `orchard` and `ironwood`, each with `start` and `end`), hex of the bytes in the order they have inside the serialised tree state. A light client server only sends the serialised states, so comparing with one means computing the root of its state; the end root is the one the scan already checks against the end state, and a run that disagrees with it is refused. The byte order of a full node's `finalRoot` (`z_gettreestate`) was not checked against these bytes: it may be the reverse of the order here, so reverse before comparing if the two differ. A verdict run without the roots is refused. The end block hash is the `hash` field of GetTreeState at the end of the range (hex, as the server wrote it), not the hash of the last block downloaded; the result says so in `end_block_hash_from`. They are read from the upstream through the proxy, so anyone can compare them with any other endpoint. Nothing here proves which host the proxy forwards to: that rests on the published configuration and on the operator's word. The `GetLightdInfo` call is made before the run's clock starts, and its time is `preflight_ms`; the tree states are the ones the run already fetched, and the bare roots are computed after every timer has stopped.
- Verdict runs use a hosted proxy, not the one on this machine. It is not deployed yet: its table entry has no host name, platform, edge or TLS termination, region or image digest, and they are filled in when it is. A hosted proxy's own files and hashes are published here too, and an entry gives a verdict only when it names its host, its hashed files, its platform, edge or TLS termination, region and image digest (`verdictReady` in `web/endpoints.mjs`); a verdict row also has to carry the observations above or it is refused, and it is refused when the server's chain name is not `main` or the end block hash is not the end tree state's. It logs the address of whoever uses it (`accessLog`). Live times include the proxy and are never corrected for it.
- What the routers allow: only the four calls the harness makes (`GetLatestBlock`, `GetBlockRange`, `GetTreeState`, `GetLightdInfo`), as POST, and OPTIONS on those paths for the browser's preflight. Any other path or method (`SendTransaction`, the address and mempool calls, a plain GET) finds no router and gets a 404, and a `rateLimit` middleware limits requests (set in `proxy/conf/dynamic.yml` to 20 requests a second with a burst of 40; Traefik's own default is no limit); it is not a cap on the proxy's total traffic. `allowOrigins` is not access control, and any client can call the four routes: it only decides which origin a browser may read the answer from, and curl or any client that is not a browser sends no `Origin` at all. What stops a hosted proxy from being an open relay is the router rule and the rate limit (no request-size limit is set: Traefik's `buffering` middleware also buffers the response, which would hold back the streamed block range and change the download time this harness measures), and the test that reads the files (`tests/proxy-files.mjs`) accepts exactly that shape and refuses anything else. Both static files turn off the version check and the usage report, so a started proxy asks the internet for nothing. `--own-mock` is refused on every local spelling (127.x, `[::1]`, `0.0.0.0`) of a port that the table gives a proxy. The routers and the rate limit were checked against a real container of the pinned image with a dead local upstream (the four calls route, the others 404, the preflight answers, the limit answers 429), with no network.
- A proxy you start from `proxy/` is the pipeline proxy: its rows read "pipeline proxy, not a verdict".
- If an operator grants CORS, the table can hold a `direct` entry (no proxy); none exists today.

### What the proxy costs
`node scripts/proxy-latency.mjs --entry http://localhost:1234 --range <start>-<end> --read-approved [--runs N] [--out file]` times `GetLatestBlock` and one `GetBlockRange` of the range you give, through the proxy (gRPC-web) and directly (gRPC over HTTP/2, `node:http2`), alternating the two runs, one uncounted call of each first. The entry is looked up in the table, which gives the upstream: the script has no option to name one. It reads the chain twice a round, so it refuses to run without `--read-approved`, for every entry of the table. It prints JSON labelled "proxied path minus a direct path, measured from <host>", with N, median, minimum and maximum of both paths, the difference, and the bytes per second of the range. It measures one host, not the phone's radio or ISP path or the browser's own fetch cost; it is per-call time and, for a long range, the throughput of the two paths from that host. Give a range the size of the row it accompanies and outside every verdict range. For a hosted proxy the honest figure is the same script run from a machine on the phone's network.

## Background

The sections from here on come from the README as it stood at commit 157a510. They hold the verdict rules, the fields and flags and the scenario scripts. They were edited to read as part of this file: links, headings and the sentences that pointed to this file changed, and the licence and credits moved to the README.

What scanning and proving cost in a browser, on phones and a laptop, timed stage by stage. It is not a sync time: there is no wallet database here.

It is part of Milestone 1 of Konclave's Zcash Community Grants grant ([forum thread](https://forum.zcashcommunity.com/t/58165)). Native mobile wallets already scan and prove; the open question here is the cost inside a phone's browser, where the Konclave app ([private, collective FROST vaults on Zcash](https://github.com/deegalabs/konclave)) runs. A row is one setting (device, browser, task, pool, endpoint, threads) run several times in one session; its median is what is judged.

Work in progress. No verdict run has been made yet, and nothing below is a result.

## Verdict charts and what counts

![No verdict run yet](../charts/no-verdict-yet.svg)

One chart per device is drawn in `charts/` once the verdict runs exist: the proof (proving key build, circuit preparation and the first proof, threads off) and the scan (the daily range of 3,456 blocks, the first-scan range of 50,000 blocks), each against its bar, with the bar drawn as a line so a pass or a fail shows at a glance (a row that failed because runs were missing or killed is drawn as that reason, with no time). Which device carries the verdict is set by [the thresholds post](https://forum.zcashcommunity.com/t/58165/15), not by the code: the Galaxy A72 for the proof and both scans, and the laptop for the proof. The Galaxy A14 and S24 Ultra are drawn against the same bars and reported as they are, pass or fail. The code gives a pass or a fail to any row of class phone, and the device label is typed by whoever runs the page, so the report names the device and the chart of another phone is not the verdict. The bars are the ones in `BARS` in `web/summarize-core.mjs`.

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

The endpoint and the range are not filled in yet, and the repository says so rather than guess: the hosted proxy has no host name in the table, and the range heights are `null` in `web/ranges.mjs`. While they are, the code gives no live row a verdict. They are filled before the first verdict run, and no verdict run is made before the objection window of the thresholds post ([forum topic 58165, post #15](https://forum.zcashcommunity.com/t/58165/15)) closes at the end of 16 November 2026 (UTC). If an objection changes a threshold, the code and these documents change before any verdict run. A proof row needs neither: holding proof verdict runs until the window closes is our commitment, not a check in the code.

The thresholds are the ones proposed in that post: the application's 1,150 daily blocks assumed 75-second blocks, and NU7 set 25 seconds in November 2026, so a day is now 3,456 blocks. The viewing key and the exact range were promised in [post #17](https://forum.zcashcommunity.com/t/58165/17).

Not judged by this harness: storage (bar 50 MB, reported with the note count) is read from the candidate wallet library and reported apart; battery has no bar, and its method will be posted on the forum for confirmation before any battery measurement. Stability (the tab must not be killed during the proof) does show here: a killed run makes its row FAIL.

## Reproduce it, in full

Before the first verdict run, this repository will hold everything needed to repeat it under the same conditions. Today the heights and the hosted proxy are still empty (see above). A run you make is informative, never a verdict (see "Community results"). The grant's acceptance check is a run of this kind: a reviewer chosen by ZCG, or any committee member, opens the benchmark on an Android phone or a laptop that is not ours and gets the same order of magnitude for that class of device.

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

Save what the page shows ("Copy all") into a `.json` file in a folder of your own (`my-results/` is ignored by git; `results/` is the project's folder), then recompute every median and verdict from the raw JSON:
```
node scripts/summarize.mjs my-results --commit <the commit the report names>
node scripts/charts.mjs my-results --commit <the commit the report names> --out my-results/charts
```
`--commit` is required: without it the build stamps cannot be checked, and the script prints no verdict and exits 2. `--session <id>` names the session that carries the verdict when a row has runs from more than one (see the flags table).

## Community results

Results from your own device can be added by pull request under `community-results/<contributor>/`, as the JSON the page gives you. They are **informative only**. The verdict is only the project's own runs under the protocol. How to send one, and what is kept, is in [community-results/README.md](../community-results/README.md).

## What the harness measures, in short

- **Proving:** the Orchard Action circuit of orchard 0.16.0, for the Ironwood or the Orchard pool, for N outputs. Key build, circuit preparation, proof and verify are timed apart; the verdict sums key build, preparation and first proof.
- **Scanning, by stage:** on a live row, the tree state before the range, the download and the tree state at its end; decode; trial decryption with the internal and the external viewing key across both pools (this stage also builds the set of spent nullifiers, as a wallet does); and the note commitment trees. Witnesses are timed apart and kept out of the total, since a wallet computes them when it spends.
- **A projection line** beside each scan row (trial decryption in actions per second, actions and compact bytes per block). It carries no pass or fail.

It does not measure a wallet database, so a number here is never a sync time. Storage comes from a candidate wallet library, not from this harness. Sapling is left out on purpose: a vault holds no Sapling key, and a wallet that has one costs more. A synthetic corpus says nothing about a real chain's density.

The sections at the top of this file have each stage, each guard and each refusal in full.

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

## Guards, in short

A run does not count when it fails any of these (the details and the reasons the report prints are in this file): the build is a clean commit and the wasm and the page script match the stamps `build.sh` wrote; the proof verified and was cold; the stages add up to the time that ran; the page was not hidden; the run started cool; the thread pool is the size asked and the page isolated; the endpoint, the range and the key are the ones the protocol names; and a verdict live row carries what the server said (chain name `main`, tree states, end block hash, and the bare tree roots of each pool at both ends). The page uploads nothing: results leave only when you copy them. A result never stores any part of a viewing key typed in, only the sha256 of its text. Both key checks were run on 2026-11-10, on a fresh clone, with no hit, and are run again at the commit that is made public: `node scripts/check-no-keys.mjs` on a fresh clone (`git clone . /tmp/kb-fresh && node scripts/check-no-keys.mjs /tmp/kb-fresh`) and `node scripts/check-history.mjs`.

The Content-Security-Policy lets the page reach only its own origin, any https host (the endpoint you may type is arbitrary) and plain http on this machine (`localhost` and `127.0.0.1`, for the pipeline proxy). It does not protect against an edited copy of the page.

## The gRPC-web proxy, in short

The proxy is Traefik (v3.7, pinned by digest) with the `grpcWeb` middleware and a `rateLimit` middleware, file provider only, no docker socket, dashboard or API. `allowOrigins` is not access control: any client can call the four routes the proxy allows, and what keeps a hosted proxy from being an open relay is that its routers allow only those four calls, together with the rate limit. The files, the table that hashes them, what a run observes of the upstream, and what is and is not proven about where the proxy forwards are in this file. A proxy you start from `proxy/` is the pipeline proxy and its rows read "pipeline proxy, not a verdict". The hosted proxy for verdict runs is not deployed yet; its files and hashes are published here when it is.

## Tests and what the proxy files were checked against

The node tests read the synthetic corpus `web/corpus/synthetic-10k.bin` when they load, and it is not in the repository (only its `.sha256` is: `web/corpus/synthetic-10k.bin.sha256`, the sha256 of the file after its first 40 bytes (magic, version and this hash) as `src/corpus.rs` defines it; `gen_corpus` writes it and the page compares the corpus with it; `sha256sum` of the whole file gives another value): on a fresh clone make it first, with the `mkdir` and `gen_corpus` lines of "Reproduce it, in full" (or of "How to reproduce" in the README), or `node --test tests/node.test.mjs` fails before its first test. The charts and scenario tests need no corpus.
```
cargo test --release
node --test tests/node.test.mjs
node --test tests/charts.test.mjs
PLAYWRIGHT_MODULE=.../playwright/index.js CHROMIUM=.../chrome node tests/browser.mjs
```
The browser test talks only to servers it starts on this machine. The routes and the rate limit of the proxy files committed here (Traefik v3.7) were checked against a container of the pinned image with a dead local upstream, with no network. An earlier version of them (Traefik v3.1, before the route limits and the rate limit) was run on 2026-11-09 against `testnet.zec.rocks`, together with `scripts/proxy-latency.mjs`, and checked by hand through `zec.rocks` and `zec.global` (a CORS preflight and one `GetLatestBlock` call each).

See [CONTRIBUTING.md](../CONTRIBUTING.md): a result is never edited by hand, and a new check comes with a test that fails without it.
