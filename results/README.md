# Results

This folder holds the project's own runs under the protocol: the raw JSON the page gives ("Copy all"), unedited, one file per session. It is empty today: no verdict run has been made.

A run in this folder is a verdict only when `node scripts/summarize.mjs results --commit <commit>` gives it one. Every verdict row of the README's results table is recomputed from a file here; a row computed from [community-results/](../community-results/README.md) is information only.
