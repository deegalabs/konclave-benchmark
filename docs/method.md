# Method

The method from end to end, with a pointer to where each part is written in full. It adds nothing that the code does not do; when the two differ, the code is right and this is a bug.

## What is timed

- Proof: key build, circuit preparation, proof and verify, each timed apart. The proof verdict sums key build, preparation and the first proof, with threads off.
- Scan: download (a live row only), decode, trial decryption with the internal and the external viewing key across both pools, and the note commitment trees. Witnesses are timed apart and left out of the total. A corpus check runs outside the timer.
- Not timed: a wallet database, Sapling, storage. A number here is never a sync time.

Each stage is in [protocol-details.md](protocol-details.md#what-each-row-times).

## Devices

The device and browser are typed by whoever runs the page, and the page records the device class (phone, laptop or other). The bars are per class (proof: 180 s for a phone, 90 s for a laptop; scan: phone only). Which device carries the verdict is set by [the thresholds post](https://forum.zcashcommunity.com/t/58165/15), not by the code: the Galaxy A72 for the proof and both scans, and the laptop for the proof. The Galaxy A14 and the S24 Ultra are reported against the same bars. The reasons for the choice are in that post and are not restated here. A row of class "other" is refused where a phone or a laptop would have a bar.

## How a run counts

A run is kept out of the median when it started hot (over 35 C, or over 2 C above the first reading of its session), when the page was hidden during it, or, on a verdict row, when no temperature could be read. A row needs at least 5 counted runs and one session; a build stamp that does not match the commit, an endpoint outside the table, a range that is not fixed and a key other than the published one each stop the row from being a verdict. A run that dies keeps its row's bar, so a tab killed during a first scan reads FAIL. The list of guards and refusals is in [protocol-details.md](protocol-details.md#guards-in-detail); the temperature is typed at the start and at the end of each run, and `scripts/battery-log.mjs` can log it from the host.

## How a community result is accepted

A result from [community-results/](../community-results/README.md) is added by pull request as the page's JSON, unedited, with the commit it was built from. Every number is recomputed from that JSON by `scripts/summarize.mjs`. It is information, never a verdict: the verdict is the project's own runs under the protocol, and nothing in that folder is read by it or drawn in its charts.

## Battery

The harness has no battery bar, and nothing has been measured. The page cannot read a battery. The method is coarse (a phone off the charger, the battery level read from the host at intervals, a fixed job repeated, the result in percentage points) and will be posted on the forum before any battery measurement is made. This file does not fix the method; the post does.
