# For a reviewer: run the benchmark on your own device

This is the acceptance check of Milestone 1 of the Konclave grant: open the benchmark on an Android phone or a laptop that is not ours and see whether you get the same order of magnitude for that class of device. A proof row and a one-day scan row take from about 6 minutes on a high-end phone to about 50 minutes on an entry phone. The page uploads nothing: results stay in the browser until you copy them. A scan row does call the light client endpoint you choose, and that server sees your address.

## 1. Get the page

Download `konclave-benchmark-656e967.zip` from the release of this repository and check it before unzipping:

- Windows (PowerShell): `Get-FileHash .\konclave-benchmark-656e967.zip -Algorithm SHA256`
- macOS or Linux: `shasum -a 256 konclave-benchmark-656e967.zip`

The hash must equal the one in the release notes. The zip holds the built page (`web/`), the local server (`scripts/serve.mjs`), the published test key (`config/test-vault.json`), a short `README.txt`, the licences and `THIRD-PARTY-NOTICES`. You need Node.js 18 or newer and nothing else. You can also build it yourself from this repository at the release commit (see the README, "How to reproduce"); the page header then shows your build's commit.

## 2. Serve it

In the unzipped folder: `node scripts/serve.mjs 8090`, then open `http://localhost:8090/` (a laptop) or, for a phone, connect it with USB debugging and run `adb reverse tcp:8090 tcp:8090`, then open `http://localhost:8090/` on the phone. Use `localhost` (or https): the page needs a secure context.

Check the header: "Harness wasm 656e967 ... page script 656e967", the same commit as the zip.

## 3. Run two rows

Close other apps and tabs. Type the device (model and RAM), pick the class (phone or laptop), and type the device's temperature (on Android, `adb shell dumpsys battery`, temperature in tenths of a degree); on a phone a run with no temperature is left out of the median.

- **Proof:** tick Prove, untick Scan, Threads off, runs 5, Run. A 2-action Ironwood proof is built 5 times.
- **One-day scan:** untick Prove, tick Scan, "This range is" = "one day of blocks (3,456)", paste the published test key from `config/test-vault.json` (`ufvk`, 195 characters, starts `uview1`) into "Viewing key to scan with", and type an endpoint in "Or a live light client endpoint (gRPC-web)":
  - `https://m1-rocks.konclave.xyz` (the project's proxy the protocol names for verdict rows) or `https://m1-global.konclave.xyz` (the project's second proxy, information), or
  - `https://zec.global`, run by Zingo Labs, which answers a browser page directly with no proxy. Zingo Labs reports that zec.global has been validated with up to 16k concurrent scanning wallets (their statement, not our measurement). A row through it is information, not a verdict.

  Then Run (5 runs).

Do not switch windows, lock the screen or reload while a row runs: the page records it and the run does not count.

## 4. Compare

The page prints a summary line per row. Compare its median with the rows of the README's results table for a device like yours (same class, ideally the same browser and endpoint). The project's own medians, single thread, from that table:

| Device | Proof (bar: 180 s phone, 90 s laptop) | One-day scan (bar: 30 s, phones only) |
|---|---|---|
| S24 Ultra 12GB (phone, high end) | about 26 s (Firefox; row short, 3 of 5 runs counted) | 38.6 to 40.2 s on every run (Firefox; row short by the temperature rule) |
| A72 6GB (phone, mid range) | 89.68 s PASS (Firefox, verdict row; 88.72 s in Chrome) | 127.74 s FAIL (Firefox through m1-rocks, verdict row; about 126 s in Chrome and directly through zec.global) |
| A14 4GB (phone, entry) | 248.63 s, printed FAIL (Firefox) | about 386 s (Firefox; row short, 2 of 5 counted) |
| Dell G7 24GB (laptop) | 43.84 s PASS (Chrome, verdict row) | 59.74 s (Chrome; information, the laptop has no scan bar) |

No phone met the 30 s one-day bar. A result is in the same order of magnitude, as we read the grant's acceptance sentence, when its median is within a factor of about 3 of the row of a comparable device; this is our reading, not a rule set by ZCG, and the phone class alone spans almost a factor of 10 (S24 to A14), so compare with the nearest device.

## 5. Send it (optional)

Click "Copy all", save the text as a `.json` file without editing it, and either attach it to your review or open a pull request adding `community-results/<your GitHub name>/` (see [community-results/README.md](../community-results/README.md)). Check it first with `node scripts/summarize.mjs community-results/<you> --commit 656e967` and `node scripts/check-no-keys.mjs`. A community result is information, never a verdict. Model, versions and measures are enough; leave out serial numbers, accounts and network names.

## If a row needs a session id

Some rows in `results/m1/` share a file with another session of the same row. Recompute them with the full session id, one command per row (S24 one day, S24 first scan, A72 Chrome proof, A72 Chrome first scan, Dell G7 one day and first scan). Each command prints every row and exits 1, because the files also hold smoke runs of other commits; read the line with the session id:

```
node scripts/summarize.mjs results/m1 --commit 37aa10f --session ba4074b6-7fb7-4d60-8a2c-6f8cd2058a68
node scripts/summarize.mjs results/m1 --commit 37aa10f --session 89309ca0-1ba3-4f59-b98f-ac84d1f68c3c
node scripts/summarize.mjs results/m1 --commit 37aa10f --session 6f51f58a-4f61-4687-a84a-67b5ca00718a
node scripts/summarize.mjs results/m1 --commit 37aa10f --session 7aed8fd1-30c0-42e7-9ef6-e778b0bf8643
node scripts/summarize.mjs results/m1 --commit 37aa10f --session dae9fe2a-3242-4370-9a29-9c9b2f0e9509
```

The S24 one-day row (ba4074b6) reads, by the temperature rule, SHORT (3 of 5 runs within the temperature rule, median of those 3 runs 39.02 s); all 5 runs are over the 30 s bar (38.59 to 40.22 s); the script prints FAIL 39.77 s with all 5 counted because the typed temperature did not follow the phone; it ran with the room's air conditioning on.
