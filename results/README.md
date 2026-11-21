# Results

The project's own runs under the protocol: the raw JSON the page gives ("Copy all"), unedited. A page export holds every run kept by that browser for that origin, so one file can hold several sessions; [m1/](m1/) has one file per device, browser and origin, and the README's results table names the session of each row.

A run in this folder is a verdict only when `node scripts/summarize.mjs results/m1 --commit 37aa10f` gives it one and the protocol names the row. Every row of the README's results table is recomputed from a file here; a row computed from [community-results/](../community-results/README.md) is information only.

Also here: the host temperature extract and logs (time and temperature only), the storage runs and the per-block action count of the one-day range, and the proxy latency file (host name withheld).
