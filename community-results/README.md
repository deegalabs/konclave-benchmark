# Community results

Anyone can send the result of a run on their own device. **These results are informative only. They are never a verdict.** The verdict of the benchmark is the project's own runs under the protocol (the repository README says which), and nothing in this folder is read by it, counted in it or drawn in its charts.

Why a community result is not a verdict: the verdict needs the project's endpoint through the project's hosted proxy, a range fixed in `web/ranges.mjs`, the published test key, at least 5 counted runs and one session per row. Even a run that follows all of that sits here as information, because nobody but you saw the device, the temperature or the session. The page shows a pass or a fail for a proof row from any device; for a result from this folder that line is information too.

## How to send one

1. Build or check out a commit of this repository, and run the page from that build (see "Reproduce it" in the README). Use the commit as it is: the page refuses to run when its script and wasm stamps differ.
2. Run the rows you want, then copy the results from the page ("Copy all") into a file. Do not edit the file: every number in a report is recomputed from the raw JSON, and an edited result cannot be trusted.
3. Check it on your side, naming the commit you built:
   ```
   node scripts/summarize.mjs community-results/<you> --commit <commit>
   ```
   Exit code 1 means a result is not of that commit.
4. Open a pull request that adds one folder, `community-results/<your GitHub name>/`, with your JSON files, and say in the description the commit you built from, the device and the browser. One folder per contributor; one pull request can add more files to it later.
5. Before you push, run `node scripts/check-no-keys.mjs` on your checkout. It fails when a viewing key appears anywhere in the tree.

If you want a chart for your own device: `node scripts/charts.mjs community-results/<you> --commit <commit> --out community-results/<you>/charts`. It draws a row only when the summary gives that row a pass or a fail.

## What a result keeps

The page writes `{ "schema": 1, "results": [...], "cleared": [...] }`. A result carries: the device label and class you typed; the user agent and Android version the browser reports, and its number of logical processors; the temperature you typed at the start and the end of each run, with the time of each run; the charging box; the session id the page made and the link parameters it applied; the row, the pool and the times of each stage; the build stamps (commit, compiler, crate versions, and the sha256 of the wasm and of the page script); the technical fields of each run (isolation mode and whether the page was cross-origin isolated, threads asked, order in the session, run id, any error text, and when a run was noted as killed or cleared); and, for a live row, the endpoint origin, what the endpoint table declares about it, and what the server said of itself and of the range (`GetLightdInfo`, the tree states at the two ends, the end block hash).

It does **not** keep any key material. If you type a viewing key into the page, the result keeps only `key_sha256`, the sha256 of the key text, and the amounts and note counts of that scan are left out unless the key is the published test key. A link can never carry a key.

What you do type is free text: the device label, the temperature and the session id are limited in length (`TEXT_LIMITS` in `web/summarize-core.mjs`) and a longer one is refused. A device label is public once it is in a pull request, so write the model and the memory, not your name.

A proxy sees the address you connect from. The project's hosted proxy, once deployed, keeps an access log with the address of each caller (see docs/protocol-details.md).
