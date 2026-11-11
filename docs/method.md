# Method

The method from end to end, with a pointer to where each part is written in full. It adds nothing that the code does not do; when the two differ, the code is right and this is a bug.

## What a verdict is

A verdict is the pass or fail of one row: the median of its counted runs against its bar in `BARS` (`web/summarize-core.mjs`). The code prints a pass or a fail for any row that clears every rule, whoever ran it and on any phone or laptop. Which of those rows the project reports as the verdict is set by the protocol, not by the code: the project's own runs, in `results/`, on the device the thresholds post names. A pass or a fail on another device, or in a community result, is information. Every other row prints its reason instead: "no bar" or "incomplete" (the row has no bar, such as a proof with another number of outputs), "short" (fewer than 5 counted runs), "REFUSED" (a guard failed), or a "not a verdict" line (threads on, a replay, a local or pipeline endpoint, an endpoint, range or key the protocol does not name, the 43.4-day range). A row with a bar whose runs died or are missing reads FAIL. The page and `node scripts/summarize.mjs <folder> --commit <commit>` apply the same rules, so anyone can recompute a verdict from the raw JSON.

No verdict run has been made. The hosted proxy has no host name in `web/endpoints.mjs` and the range heights are `null` in `web/ranges.mjs`, so today the code gives no live scan row a verdict. The published test key is `config/test-vault.json`; the range heights go into `web/ranges.mjs` before the first verdict run.

## What is timed

- Proof: key build, circuit preparation, proof and verify, each timed apart. The proof verdict sums key build, preparation and the first proof, with threads off; preparation takes milliseconds, so counting it errs on the slow side.
- Scan: on a live row, the tree state before the range, the download and the tree state at its end; then decode, trial decryption with the internal and the external viewing key across both pools, and the note commitment trees. Witnesses are timed apart and left out of the total. The corpus check (replay) and the server's `GetLightdInfo` call (live) run outside the timer.
- Not timed: a wallet database, Sapling, storage. A number here is never a sync time. Storage has a bar in the thresholds post (under 50 MB, reported with the note count); it is read from the candidate wallet library and reported apart, not by this harness.

Each stage is in [protocol-details.md](protocol-details.md#what-each-row-times).

## Devices

The device label and the device class (phone, laptop or other) are typed by whoever runs the page; the browser is read from its user agent. The bars are per class, as proposed in [the thresholds post](https://forum.zcashcommunity.com/t/58165/15): proof 180 s for a phone and 90 s for a laptop; scan, phone only, 30 s for the daily range and 10 min for the first scan. The post asks for objections by 16 November 2026 (UTC). No verdict run is made before then, and if an objection changes a threshold, the code and these documents change first. A proof row needs no endpoint or range, so for the proof this wait is a commitment, not a check in the code. Which device carries the verdict is set by that post, not by the code: the Galaxy A72 for the proof and both scans, and the laptop for the proof. The Galaxy A14 and the S24 Ultra are reported against the same bars, as their own rows, never the verdict. A row of class "other" is refused where a phone or a laptop would have a bar.

## How a run counts

A run is kept out of the median when it started hot (over 35 C, or over 2 C above the first reading of its session), when the page was hidden during it, or, on a verdict row, when no temperature was recorded. A row needs at least 5 counted runs and one session; a build stamp that does not match the commit, an endpoint outside the table, a range that is not fixed and a key other than the published one each stop the row from being a verdict. A run that dies keeps its row's bar, so on a verdict row a tab killed during the proof or a first scan reads FAIL. The list of guards and refusals is in [protocol-details.md](protocol-details.md#guards-in-detail); the temperature is typed at the start and at the end of each run; `scripts/battery-log.mjs` can log it from the host to a file, and the summary reads only the typed field.

## How a community result is sent

A result for [community-results/](../community-results/README.md) is sent by pull request as the page's JSON, unedited, naming in the description the commit it was built from, the device and the browser. Anyone can recompute every number from that JSON with `node scripts/summarize.mjs community-results/<name> --commit <commit>`; CI does not run it on that folder. A maintainer merges the pull request when that command exits 0 for the named commit (every file parses as JSON and every run is of that commit) and `node scripts/check-no-keys.mjs` passes; CI runs the key check on every pull request. It is information, never a verdict: the verdict is the project's own runs under the protocol, and nothing in that folder is read by it or drawn in its charts.

## Battery

The harness has no battery bar, and nothing has been measured. The page cannot read a battery. The method is coarse (a phone off the charger, the battery level read from the host at intervals, a fixed job repeated, the result in percentage points) and will be posted on the forum for confirmation, separately, before any battery measurement is made. This file does not fix the method; the post does.
