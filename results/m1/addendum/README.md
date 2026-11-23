# Milestone 1 addendum, 22 and 23 November 2026 (information rows, never verdicts)

Four questions the reviews of the Milestone 1 design raised, measured after the verdict runs: does a parallel tree change the one-day range, how much storage does the candidate wallet library use on a phone, how much does a proof cost with more outputs or in the Orchard pool, and how fast the scan runs natively. The method was fixed in an internal note before each run (not published). Nothing here changes a verdict row of the README.

Build: every row below ran on commit `5ac328d` (branch `feat/parallel-subtree-insert`), except storage, which uses the WebZjs build of the desktop storage rows (red-dev-inc/WebZjs PR #27, commit `9ad0a589`). `5ac328d` adds a third tree insertion mode, `subtrees`: each chunk of 10,000 blocks is cut into pieces of 1,024 leaves counted from its first position, each piece built apart as a located subtree (in parallel with threads) and inserted in order with `insert_tree`, as zcash_client_backend 0.25 does in `update_tree` and `build_subtrees`. The chunked default and the per-block mode are unchanged. A first version of the mode (commit `8b4702a`) split at shard boundaries, so a chunk gave one or two pieces and almost nothing ran in parallel; the code review found it, one A72 block run on it was stopped and is not reported, and the Dell build made from it was withdrawn before use.

Recompute a scan or proof row with one command per folder: `node scripts/summarize.mjs results/m1/addendum --commit 5ac328d` (22 November), `node scripts/summarize.mjs results/m1/addendum/cold --commit 5ac328d` (the A72 on 23 November) and `node scripts/summarize.mjs results/m1/addendum/s24 --commit 5ac328d` (the S24 on 23 November). Each phone file is the phone's whole export and also holds older sessions, which these commands refuse as another commit. Native rows: `native/*.jsonl`, one JSON line per run, from `cargo run --release [--features threads] --example native_scan -- <corpus> <ufvk file> <mode> 5`.

## Parallel tree: the one-day range replayed from the saved corpus

All rows: the one-day range 3,577,413 to 3,580,868 from `web/corpus/daily-3577413-3580868.bin` (identity `6f625750...df017901`, no network) unless marked live, the published test key, 5 runs per setting; the threads page runs a 1-thread control before each threaded row in the same session. Medians of the tree stage and of the total (decode, decryption, tree).

**Dell G7 24GB, Chrome 157, on the charger, run by the second operator** (`dell-g7-subtrees-2026-11-22.json`; block order A, B, D, C so heat does not favour one mode; the Dell's thermal zone read 25.1 °C throughout and does not respond to heat). Block A recorded `charging: false` because the page's charger box was left unticked; Windows reported AC power right after it.

| Block, session | Mode | Threads | Tree | Total |
|---|---|---|---|---|
| B `8c84147d` | chunked | 1 / 4 | 30.38 / 30.35 s | 58.14 / 38.96 s |
| A `56a62bae` | subtrees | 1 / 4 | 44.20 / 23.45 s | 73.45 / 32.26 s |
| D `3d840239` | chunked | 1 / 12 | 30.41 / 30.26 s | 58.03 / 36.08 s |
| C `0056900c` | subtrees | 1 / 12 | 38.91 / 19.52 s | 66.43 / 24.98 s |

**Desktop control: this project's desktop (AMD Ryzen 7 5700X3D, 16 threads, WSL2), headless Chromium, driven by a script** (`desktop-*.json`, same block order).

| Block, session | Mode | Threads | Tree | Total |
|---|---|---|---|---|
| B `a46e85e9` | chunked | 1 / 4 | 25.58 / 25.48 s | 48.15 / 32.00 s |
| A `79425b54` | subtrees | 1 / 4 | 34.54 / 16.85 s | 57.47 / 23.25 s |
| D `978e7012` | chunked | 1 / 16 | 25.51 / 25.35 s | 48.43 / 29.00 s |
| C `4ff29625` | subtrees | 1 / 16 | 32.16 / 14.40 s | 54.77 / 18.12 s |

**A72 6GB, Chrome 157, on the PC's USB cable (the operator's note; the page's charger box was left unticked, so every A72 run records `charging: false`), Run started through Chrome devtools** (`a72-chrome-2026-11-22.json`, `a72-markers.log`; replay blocks subtrees then chunked, live blocks through `m1-rocks` chunked then subtrees). One temperature was read and typed per block (the counted block at 34.7 °C, 0.3 °C under the ceiling), and three of the four blocks started above 35 °C, so by the protocol's hot-start rule their runs are excluded from the printed median ("hot start", and the threaded row "no control"). The medians below are of all runs, shown as information with that condition, not counted rows. For comparison, the A72 live chunked verdict row of 17 November, in Firefox 160, single thread (session `ad4f402f`), had a tree stage of 68.20 s and a total of 127.74 s. The export also holds the stopped `8b4702a` block (not reported).

| Block, session | Mode | Threads | Tree | Total | Typed start temperature |
|---|---|---|---|---|---|
| replay `dde98595` | subtrees | 1 / 4 | 86.08 / 64.62 s | 141.64 / 92.50 s | 34.7 °C (counted) |
| replay `6f1e4b02` | chunked | 1 / 4 | 83.06 / 83.06 s | 152.81 / 110.77 s | 36.4 °C (hot start) |
| live `e7ffccc2` | chunked | 1 / 4 | 84.89 / 85.11 s | 156.31 / 114.41 s | 36.1 °C (hot start) |
| live `1e7f9f14` | subtrees | 1 / 4 | 106.13 / 65.18 s | 177.43 / 94.43 s | 35.2 °C (hot start) |

**Native, the same desktop** (`native/`, rustc 1.89.0-nightly 2025-06-14, 5 runs; WSL2 is a VM layer, so these times may be slower than on native Linux on the same machine: an upper bound for it, not a measure of it). Desktop temperatures were not recorded.

| Mode | Threads | Decryption | Tree | Total |
|---|---|---|---|---|
| chunked | 1 | 5.53 s | 5.79 s | 11.34 s |
| subtrees | 1 | 5.52 s | 7.36 s | 12.90 s |
| chunked | 16 | 0.73 s | 5.78 s | 6.53 s |
| subtrees | 16 | 0.74 s | 3.31 s | 4.08 s |

What these show: with the chunked default, threads leave the tree stage where it was (Dell 30.4 s at 1, 4 and 12 threads; desktop 25.5 s at 1, 4 and 16), which is what the design document reported. With `subtrees`, the tree stage falls with threads; against the chunked default at the same thread count, it is lower by about 23% at 4 threads on the Dell (30.35 to 23.45 s) and on the A72 (about 83 to 65 s, in both block orders, with the heat condition above), 34% at 4 threads on the desktop, 35% at 12 threads on the Dell and 43% at 16 on the desktop and natively. With one thread, `subtrees` is slower than chunked (the pieces cost something). On the A72 the best threaded one-day range is about 93 s on 22 November and 76 s in the cold rerun of 23 November (below), against the phone's 30 s bar; on the Dell with all 12 threads it is 24.98 s.

## Storage on the A72 (WebZjs PR #27, view-only sync of the published test key to the chain tip)

The probe of the desktop storage rows (`storage/` here; serialized wallet with `db_to_bytes`, the origin's `navigator.storage.estimate()` after the IndexedDB write), on the A72 in Chrome 157 over the PC's USB cable, through a local read-only gRPC-web proxy to zec.rocks, fresh site data before each run (`storage/markers.log`).

| Run | From height | Blocks recorded | Serialized | IndexedDB | Sync |
|---|---|---|---|---|---|
| `a72-s2-run1` | 3,558,848 | 42,357 | 2,975,919 B | 1,918,681 B | 570.7 s |
| `a72-s2-run2` | 3,558,848 | 42,379 | 2,979,122 B | 1,922,576 B | 570.0 s |
| `a72-s3-run2` | 3,530,869 | 70,446 | 4,862,633 B | 3,142,155 B | 956.0 s |

The growth per block between the two birthdays (runs `a72-s2-run1` and `a72-s3-run2`) is 67.17 B serialized and 43.56 B in IndexedDB on the A72, against 67.23 B and 44.44 B on the desktop rows, so the twelve-month projection of the README (86.8 MB serialized, over the 50 MB bar) is the same on the phone. A first attempt from 3,530,869 (`a72-s3-run1`) was lost: the tab reloaded about 7 minutes in, with no error on the page and no kill of a Chrome process in Android's exit records; tabs of earlier runs were still open then and were closed before the retry, whose renderer peaked at about 728 MB.

## Proofs with more outputs and in the Orchard pool (A72, Chrome 157, threads off)

Timed as the proof verdict row (key build, preparation and proof), every proof verified.

| Row, session | Pool | Outputs | Runs | Median |
|---|---|---|---|---|
| `6a34c560` | Ironwood | 8 | 3 | 223.77 s |
| `0d393b32` | Ironwood | 4 | 3 | 133.25 s |
| `ee1040e6` | Orchard | 2 | 5 | 88.19 s |

These are information rows; the summarizer prints them with no bar (the 180 s phone proof bar applies to the 2-output verdict row only), and 223.77 s is above that figure.

Beside the Ironwood 2-output proof in the same browser (Chrome 157, session `6f51f58a` of 18 November, 88.72 s; the verdict row is Firefox 160, 89.68 s): about 22 s per output on the A72. An old vault that spends Orchard notes and pays into Ironwood proves both bundles; the sum of the two 2-output proofs is about 177 s in Chrome, an estimate by addition that counts two key builds, not a measured two-bundle transaction.

## Cold rerun on 23 November: the A72 again, and the S24 Ultra

Because three of the four A72 tree blocks of 22 November started above 35 °C, the same four blocks were run again on 23 November, and on the S24 Ultra 12GB too: build `5ac328d`, Chrome 157, each phone off the charger and reached over Wi-Fi adb (so `charging: false` is correct here), in an air-conditioned room, Run started through Chrome devtools. Before each block a script read the battery temperature every 30 s and started the block only at 30.0 °C or less and no more than 1.0 °C above that phone's first block start (`*-temps-2026-11-23.log`); colder starts were allowed, as the protocol's rule allows them. Every block below starts under 35 °C, so no run is excluded by the hot-start rule. Files: `cold/` (A72) and `s24/`, each phone's whole export plus its markers and temperature log.

**A72, cold.** Two live starts at 11:21 UTC failed before any run (a Run button still disabled, a devtools connection timeout). A live chunked attempt at 11:33 UTC was stopped during its first run, which had not finished after 30 minutes, because the phone's screen turned off and hid the page (session `8b9addd3`, one partial record marked killed, not reported); the screen timeout was then set to its maximum for the session (and set back to its earlier value after the session, as recorded by the operator, not in these files). In the reported live chunked session the first 1-thread run was hidden during the run (the cause was not recorded) and is excluded (4 of 5 counted). The chunked replay row `3a9d24c9` is refused by the summarizer: in two of its 4-thread runs the page saw 31.5 and 37.6 s (preflight, before the stages) that no stage accounts for; its stage medians are shown as information, and its tree stage (69.11 s) matches the live chunked row (69.14 s).

| Block, session | Mode | Threads | Tree | Total | Start |
|---|---|---|---|---|---|
| replay `75289f16` | subtrees | 1 / 4 | 86.13 / 52.94 s | 142.57 / 76.12 s | 27.5 °C |
| replay `3a9d24c9` | chunked | 1 / 4 | 70.58 / 69.11 s | 126.65 / 92.60 s | 27.5 °C |
| live `f4203728` | chunked | 1 / 4 | 67.76 / 69.14 s | 149.33 / 114.64 s | 25.6 °C |
| live `27935e62` | subtrees | 1 / 4 | 87.82 / 53.90 s | 215.69 / 119.02 s | 28.5 °C |

**S24 Ultra, cold.**

| Block, session | Mode | Threads | Tree | Total | Start |
|---|---|---|---|---|---|
| replay `d3e076f3` | subtrees | 1 / 4 | 41.02 / 22.12 s | 70.29 / 30.13 s | 30.0 °C |
| replay `c1ac4c4b` | chunked | 1 / 4 | 32.10 / 32.12 s | 61.37 / 39.90 s | 29.9 °C |
| live `0570ea4c` | chunked | 1 / 4 | 32.08 / 31.98 s | 63.28 / 41.39 s | 29.8 °C |
| live `51eebc95` | subtrees | 1 / 4 | 41.11 / 21.51 s | 72.04 / 31.07 s | 30.0 °C |

What the cold rows add: at 4 threads, `subtrees` lowers the tree stage against chunked by 23% on the A72 (69.11 to 52.94 s, replay, both blocks at 27.5 °C; live 69.14 to 53.90 s, starts 25.6 and 28.5 °C) and 31% on the S24 (32.12 to 22.12 s, replay, 29.9 and 30.0 °C), the same as the 22 November A72 rows (22.2 and 23.4%). Cold and off the charger, the A72 is faster than on 22 November in the stages on the device (replay, 4 threads, subtrees: 92.50 s at 34.7 °C on 22 November, 76.12 s at 27.5 °C). The S24's best one-day range is 30.13 s (replay) and 31.07 s (live), against the phone's 30 s bar, from about 40 s with chunked; these are information rows, not verdicts, with 4 of the S24's 8 cores. On the A72 over Wi-Fi the live download took 20.72 and 34.10 s at 4 threads and 24.28 and 68.78 s at 1 thread (0.6 to 0.9 s over the USB cable on 22 November), so the A72 live totals compare the tree stage, not the network.

**Storage on the S24** (`storage/s24-s2-run1.json`, the same probe and proxy as the A72 rows, over Wi-Fi adb; the charging state was not recorded in that run): from 3,558,848, 44,686 blocks recorded, 3,134,129 B serialized, 2,018,552 B in IndexedDB, sync 213.9 s. That is 70.14 B per block serialized, as on the A72 (70.26 B for the same birthday). The battery and temperature were not read in that run's markers (`storage/s24-markers.log`: the S24 prints its battery event history in the same output).

**Storage on the A14 and the laptop** (23 November, the same probe, birthdays and fresh site data as the A72 rows; information rows, method fixed in an internal note before the runs). The A14 ran in Chrome 157 over Wi-Fi adb (on the charger, as read on the phone before the runs; not in the files), through the same local proxy to zec.rocks (`storage/a14-markers.log`; the A14 prints its battery history in the same output, so battery and temperature were not read). The laptop (Dell G7, Chrome 157, Windows 11) ran directly through `zec.global` (run by Zingo Labs); the operator noted it was on the charger and that each run used a new private window (not in the files). Sync time is not a result here: it depends on the server and the network.

| Run | Device | From height | Blocks recorded | Serialized | IndexedDB |
|---|---|---|---|---|---|
| `a14-s2-run1` | A14 | 3,558,848 | 44,964 | 3,152,774 B | 2,030,600 B |
| `a14-s3-run1` | A14 | 3,530,869 | 73,059 | 5,041,999 B | 3,257,249 B |
| `dell-s2-run1` | Dell G7 | 3,558,848 | 45,317 | 3,192,041 B | 2,125,824 B |
| `dell-s3-run1` | Dell G7 | 3,530,869 | 73,331 | 5,065,135 B | 3,346,432 B |

Growth per block between the two birthdays: 67.24 B serialized and 43.66 B in IndexedDB on the A14, 66.86 B and 43.57 B on the laptop, against 67.17 B and 43.56 B on the A72 and 67.23 B and 44.44 B on the desktop rows, so the serialized growth agrees within 0.6% on the four devices measured from two birthdays and the twelve-month serialized projection of the README holds on each; the IndexedDB growth is 43.56 to 43.66 B on the three devices measured here, about 2% under the desktop's 44.44 B. The S24 was measured from one birthday only, so it gives no growth rate. The site data before a run was 0 to 3,139 B (`storageUsageBeforeBytes`; 3,139 B before `a14-s3-run1`, 2,252 B before `a72-s3-run2`), included in the IndexedDB column as in the A72 table. Every run ended at the chain tip with 2 notes, 2 transactions and no sync error. A first pair of laptop runs had the browser's device emulation on by mistake (their user agent reads Pixel 10 and iPhone; the operator checked in the browser that CPU and network were not throttled in the second): 3,162,170 B and 5,066,351 B serialized, -0.94% and +0.02% from these, and 2 notes, 2 transactions and no sync error, kept as `storage/dell-s2-emulated.json` and `storage/dell-s3-emulated.json` and not used.
