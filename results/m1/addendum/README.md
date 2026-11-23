# Milestone 1 addendum, 22 and 23 November 2026 (information rows, never verdicts)

Four questions the reviews of the Milestone 1 design raised, measured after the verdict runs: does a parallel tree change the one-day range, how much storage does the candidate wallet library use on a phone, how much does a proof cost with more outputs or in the Orchard pool, and how fast the scan runs natively. The method was fixed in an internal note before each run (not published). Nothing here changes a verdict row of the README.

Build: every row below ran on commit `5ac328d` (branch `feat/parallel-subtree-insert`), except storage, which uses the WebZjs build of the desktop storage rows (red-dev-inc/WebZjs PR #27, commit `9ad0a589`). `5ac328d` adds a third tree insertion mode, `subtrees`: each chunk of 10,000 blocks is cut into pieces of 1,024 leaves counted from its first position, each piece built apart as a located subtree (in parallel with threads) and inserted in order with `insert_tree`, as zcash_client_backend 0.25 does in `update_tree` and `build_subtrees`. The chunked default and the per-block mode are unchanged. A first version of the mode (commit `8b4702a`) split at shard boundaries, so a chunk gave one or two pieces and almost nothing ran in parallel; the code review found it, one A72 block run on it was stopped and is not reported, and the Dell build made from it was withdrawn before use.

Recompute a scan or proof row: `node scripts/summarize.mjs results/m1/addendum --commit 5ac328d` (the A72 file is the phone's whole export and also holds older sessions, which that command refuses as another commit). Native rows: `native/*.jsonl`, one JSON line per run, from `cargo run --release [--features threads] --example native_scan -- <corpus> <ufvk file> <mode> 5`.

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

**A72 6GB, Chrome 157, on the PC's USB cable (the operator's note; the page's charger box was left unticked, so every A72 run records `charging: false`), Run started through Chrome devtools** (`a72-chrome-2026-11-22.json`, `a72-markers.log`; replay blocks subtrees then chunked, live blocks through `m1-rocks` chunked then subtrees). One temperature was read and typed per block (the counted block at 34.7 °C, 0.3 °C under the ceiling), and three of the four blocks started above 35 °C, so by the protocol's hot-start rule their runs are excluded from the printed median ("hot start", and the threaded row "no control"). The medians below are of all runs, shown as information with that condition, not counted rows. For comparison, a cold A72 live chunked row of 20 November, single thread (session `ad4f402f`, the verdict row), had a tree stage of 68.20 s and a total of 127.74 s. The export also holds the stopped `8b4702a` block (not reported).

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

What these show: with the chunked default, threads leave the tree stage where it was (Dell 30.4 s at 1, 4 and 12 threads; desktop 25.5 s at 1, 4 and 16), which is what the design document reported. With `subtrees`, the tree stage falls with threads; against the chunked default at the same thread count, it is lower by about 23% at 4 threads on the Dell (30.35 to 23.45 s) and on the A72 (about 83 to 65 s, in both block orders, with the heat condition above), 34% at 4 threads on the desktop, 35% at 12 threads on the Dell and 43% at 16 on the desktop and natively. With one thread, `subtrees` is slower than chunked (the pieces cost something). On the A72 the best threaded one-day range is still about 93 s against the phone's 30 s bar; on the Dell with all 12 threads it is 24.98 s.

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

Beside the Ironwood 2-output proof in the same browser (Chrome 157, session `6f51f58a` of 20 November, 88.72 s; the verdict row is Firefox 160, 89.68 s): about 22 s per output on the A72. An old vault that spends Orchard notes and pays into Ironwood proves both bundles; the sum of the two 2-output proofs is about 177 s in Chrome, an estimate by addition that counts two key builds, not a measured two-bundle transaction.
