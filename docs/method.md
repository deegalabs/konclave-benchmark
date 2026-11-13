# Method

The method from end to end, with a pointer to where each part is written in full. It adds nothing that the code does not do; when the two differ, the code is right and this is a bug.

## What a verdict is

A verdict is the pass or fail of one row: the median of its counted runs against its bar in `BARS` (`web/summarize-core.mjs`). The code prints a pass or a fail for any row that clears every rule, whoever ran it and on any phone or laptop. Which of those rows the project reports as the verdict is set by the protocol, not by the code: the project's own runs, in `results/`, on the device the thresholds post names. A pass or a fail on another device, or in a community result, is information. Every other row prints its reason instead: "no bar" or "incomplete" (the row has no bar, such as a proof with another number of outputs), "short" (fewer than 5 counted runs), "REFUSED" (a guard failed), or a "not a verdict" line (threads on, a replay, a local or pipeline endpoint, an endpoint, range or key the protocol does not name, the 43.4-day range). A row with a bar whose runs died or are missing reads FAIL. The page and `node scripts/summarize.mjs <folder> --commit <commit>` apply the same rules, so anyone can recompute a verdict from the raw JSON.

No verdict run has been made. The two hosted proxies are in `web/endpoints.mjs`, but the range heights are `null` in `web/ranges.mjs`, so today the code gives no live scan row a verdict. The published test key is `config/test-vault.json`; the range heights go into `web/ranges.mjs` before the first verdict run, by the rule in "What is fixed before the runs".

## What is fixed before the runs

Four choices are fixed before the verdict runs of 17 November 2026. Each one is also checked by the code where the code can check it; the rest are the project's commitments.

1. **The ranges.** T is the highest block whose block time is before 2026-11-17 00:00:00 UTC, and every block above T, up to the tip, has a block time at or after that moment. The block time is the `time` of the block header (field 5 of the compact block). Block times are not monotonic in Zcash, so T is not found by one comparison: the consensus rule that a block's time is above the median of the 11 blocks before it means that, once 11 consecutive blocks have a time at or after the cutoff, every later block does too. `scripts/fix-ranges.mjs` finds a block before the cutoff by bisection, walks up to the first 11 consecutive blocks at or after it, and takes the last block before the cutoff it met; it refuses a tip that is still before the cutoff or has fewer than 11 blocks past T. Those 11 blocks are why T is final by consensus. The heights are read only once the tip is at least 100 blocks past T, a margin against a reorganisation, and the script refuses with fewer. Block explorers show block times in UTC. Anyone can check T from the block times, by reading the blocks after T as well as T: T has a time before the cutoff and every block after it has a time at or after it.
   - `daily`: T-3,455 to T (3,456 blocks).
   - `first-scan`: T-49,999 to T (50,000 blocks).
   - `first-scan-43d` (information only): T-149,999 to T (150,000 blocks, 43.4 days at 3,456 blocks a day).
   The heights are written into `web/ranges.mjs` by pull request on 17 November 2026 and published before the first verdict run. `node scripts/fix-ranges.mjs <endpoint> --read-approved` prints T, its time and hash (as the server sent it) and the three ranges; with `--write` it writes only the six heights.
2. **The browser and the laptop.** The verdict row on the Galaxy A72 is Firefox. Other browsers, Chrome among them, are run and reported beside it as information. The verdict row of the laptop proof (bar 90 s) is Chrome on the laptop Dell G7, 24 GB. Firefox on that laptop is reported beside it as information.
3. **The endpoint.** The verdict row is the one through `https://m1-rocks.konclave.xyz` (`zec.rocks`). The row through `https://m1-global.konclave.xyz` (`zec.global`) is reported beside it as information. The code gives both rows the same rules, so it prints a pass or a fail for either; the protocol says the first is the verdict.
4. **The session.** For each verdict row, the first session started on 17 November 2026 is the verdict, whatever it gives: pass, FAIL or short. A row is not run again to get another number. Later sessions are information.

## What is timed

- Proof: key build, circuit preparation, proof and verify, each timed apart. The proof verdict sums key build, preparation and the first proof, with threads off; preparation takes milliseconds, so counting it errs on the slow side.
- Scan: on a live row, the tree state before the range, the download and the tree state at its end; then decode, trial decryption with the internal and the external viewing key across both pools, and the note commitment trees. Witnesses are timed apart and left out of the total. The corpus check (replay) and the server's `GetLightdInfo` call (live) run outside the timer.
- The tree stage: the commitments of each pool go into a shard tree with one `batch_insert` per chunk of 10,000 blocks, and the tree keeps a checkpoint for every block (a block with no commitments gets its checkpoint at the position of the last leaf before it). Every leaf of the range is hashed. The chunks are the same code for every scan, so the daily range of 3,456 blocks is one chunk and a first scan of 50,000 blocks is five. A row asked for per-block insertion (the page option, or `tree=per-block` in a link) calls `batch_insert` once per block instead; it is information, printed with its bar and never a verdict. Each result records the mode (`tree_insert`: `chunk-10000` or `per-block`), and the stage keeps the name `tree` in both so the two compare.
- Not timed: a wallet database, Sapling, storage. A number here is never a sync time. Storage has a bar in the thresholds post (under 50 MB, reported with the note count); it is read from the candidate wallet library and reported apart, not by this harness.

Each stage is in [protocol-details.md](protocol-details.md#what-each-row-times).

## Devices

The device label and the device class (phone, laptop or other) are typed by whoever runs the page; the browser is read from its user agent. The bars are per class, as proposed in [the thresholds post](https://forum.zcashcommunity.com/t/58165/15): proof 180 s for a phone and 90 s for a laptop; scan, phone only, 30 s for the daily range and 10 min for the first scan. The post asks for objections by 16 November 2026 (UTC). No verdict run is made before then, and if an objection changes a threshold, the code and these documents change first. A proof row needs no endpoint or range, so for the proof this wait is a commitment, not a check in the code. Which device carries the verdict is set by that post, not by the code: the Galaxy A72 for the proof and both scans, and the laptop for the proof. The Galaxy A14 and the S24 Ultra are reported against the same bars, as their own rows, never the verdict. A row of class "other" is refused where a phone or a laptop would have a bar.

## How a run counts

A run is kept out of the median when it started hot (over 35 C, or over 2 C above the first reading of its session), when the page was hidden during it, or, on a verdict row, when no temperature was recorded. A row needs at least 5 counted runs and one session; a build stamp that does not match the commit, an endpoint outside the table, a range that is not fixed and a key other than the published one each stop the row from being a verdict. A run that dies keeps its row's bar, so on a verdict row a tab killed during the proof or a first scan reads FAIL. The list of guards and refusals is in [protocol-details.md](protocol-details.md#guards-in-detail); the temperature is typed at the start and at the end of each run; `scripts/battery-log.mjs` can log it from the host to a file, and the summary reads only the typed field.

## How a community result is sent

A result for [community-results/](../community-results/README.md) is sent by pull request as the page's JSON, unedited, naming in the description the commit it was built from, the device and the browser. Anyone can recompute every number from that JSON with `node scripts/summarize.mjs community-results/<name> --commit <commit>`; CI does not run it on that folder. A maintainer merges the pull request when that command exits 0 for the named commit (every file parses as JSON and every run is of that commit) and `node scripts/check-no-keys.mjs` passes; CI runs the key check on every pull request. It is information, never a verdict: the verdict is the project's own runs under the protocol, and nothing in that folder is read by it or drawn in its charts.

## Battery

The harness has no battery bar, and nothing has been measured. The page cannot read a battery: battery is read on the host, outside the page. The method below is a proposal. It will be posted on the forum for confirmation before any battery measurement is made, and this file does not fix it; the post does. Battery results are information, never a verdict.

### Phones (proposal)

A phone off the charger, reached by adb over Wi-Fi so it is not charging, with the battery between 80% and 60% at the start. The host reads `dumpsys battery` every 10 s: the level, the charge counter and `current now` (`scripts/battery-log.mjs` records the level, temperature and charging state today; the counter and current fields are added before any battery measurement). A fixed job is repeated, and the result is the energy used per job, net of an idle baseline of the same length, from the charge counter where it moves with use and from `current now` summed over the run. On a phone whose counter scale does not match its battery, the share of the counter or of the level used is reported instead of mAh.

### Laptop (proposal)

The verdict laptop (Dell G7, 24 GB) is unplugged for the whole run. The host logs the battery's `RemainingCapacity` (mWh, from the Windows `root\wmi` `BatteryStatus` class) every 10 s with the time, and the start and the end of each run are marked by their timestamps. The result is the drop in `RemainingCapacity` between the start and the end of the run, net of an idle baseline of the same length taken just before or after, with the laptop on the same settings and nothing else running. As a cross-check, the drop in `RemainingCapacity` over the whole unplugged session is compared with that session's row in `powercfg /batteryreport`, the battery's own report. `DischargeRate` from the same class is not used as the measure: in a check of the counters during ordinary use, not a benchmark run, it read about 7% above the capacity drop, while the capacity drop and the report row differed by about 1.2%. The smallest change seen in `RemainingCapacity` was 15 mWh, and a reading every 10 s at about 13 W moves about 36 mWh, so each end of a run is known to within a few tens of mWh.

### Length of a battery run (proposal)

A battery run lasts at least 20 minutes, on the laptop and on the phones. A workload shorter than that is repeated until the 20 minutes are covered, and the number of repetitions is reported with the result. The idle baseline lasts as long as the run. Every result keeps its uncertainty:

- Laptop: about 50 mWh over the two ends of a run against about 4,300 mWh drained in 20 minutes at about 13 W, so about 1%.
- Phones: the charge counter moves in steps of about 5 mAh, about 10 mAh over the two ends of a run. At about 450 mA, 20 minutes drain about 150 mAh, so the counter alone gives about 7%; `current now` summed every 10 s is reported beside it as the finer reading. A phone whose counter moves in larger steps, or whose counter scale does not match its battery, reports the share used with its own step size stated.

Nothing that identifies a device leaves the host: published battery results hold the model, the energy per job and, for phones, the battery temperature, not serials, account names, network names, raw battery history or the battery report file.
