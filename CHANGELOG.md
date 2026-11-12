# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project has no released version yet.

## [Unreleased]

Starts at commit 157a510 (the bare note-commitment tree roots of each scan are recorded).

### Added

- `web/ranges.mjs`: the first-scan-43d row holds 150,000 blocks and ends at T like the others (T-149,999 to T); `scripts/fix-ranges.mjs` writes it with the other two.
- `scripts/fix-ranges.mjs`: finds T, the highest block with a block time before 2026-11-17 00:00:00 UTC (with 11 consecutive blocks at or after it above T, so a block time out of order cannot move it), and prints the three verdict ranges; with `--write` it writes only the six heights into `web/ranges.mjs`. It reads the chain only with `--read-approved`. `scripts/mock-lightwalletd.mjs` can serve a chain of block times for its tests.
- `docs/method.md`, "What is fixed before the runs": the range rule, Firefox as the verdict browser on the A72 and Chrome on the verdict laptop (Dell G7, 24 GB) with the other browsers as information, the row through `m1-rocks` as the verdict endpoint with `m1-global` as information, and the first session started on 17 November 2026 as the verdict of each row. The README limits and `docs/protocol-details.md` no longer say one endpoint.
- The two hosted gRPC-web proxies on Railway, `https://m1-rocks.konclave.xyz` (to `zec.rocks:443`) and `https://m1-global.konclave.xyz` (to `zec.global:443`): their files in `proxy/hosted/` (byte for byte as deployed, no SPDX line, so the table's hash is the hash of what runs), table entries that are verdict-ready, a test that derives the upstream, the pinned image, the trusted edge range and the rate-limit key from the files and checks the hashes. A live row through either is judged on its range and key.
- The docs state what the platform logs: no access log in the proxy; the Railway edge records the source IP address, user agent, host, path, method, status, byte counts, timings and edge region. This replaces the earlier statement that the hosted proxy keeps an access log with the address of each caller. The rate limit is keyed on the client address the edge forwards (trusted edge range 100.64.0.0/10).
- The tree stage inserts the commitments of a range in chunks of 10,000 blocks, one `batch_insert` per chunk with a checkpoint kept for every block, instead of one `batch_insert` per block. A block with no commitments in a pool gets a checkpoint at the position of the last leaf before it; every block has one in this harness, by its own choice, so that the two insertion modes have the same checkpoints. The position rule is the one `ensure_checkpoints` in zcash_client_backend uses for a height at which another pool has a commitment or an anchor-retention policy keeps a checkpoint; that function does not checkpoint a block that is empty in every pool. After the empty blocks' checkpoints are added the tree is pruned to the 100 kept, in both modes, so a per-block row now does a little work for a block with no commitments, which the earlier per-block code did not. The chunks are the same code for every scan: the daily range of 3,456 blocks is one chunk, and a first scan of 50,000 blocks is five. The checkpoint ids now count every block of the range, not only those with commitments.
- Per-block insertion stays as an information row: the page option "Tree stage inserts" and the link parameter `tree=per-block`. Each result records `tree_insert` (`chunk-10000` or `per-block`) and the page records `tree_insert_asked`. The summary prints a per-block row with its bar as information and never gives it a verdict; a scan result without the mode, with a chunked mode other than `chunk-10000` (`chunk-1` included), without `tree_insert_asked` or with another than the one asked, is refused.
- `examples/tree_chunks.rs`, a native timing of the tree stage of one pool over random commitments, chunked against per-block, with the root compared.
- `tests/tree_insert.rs`: chunked and per-block insertion give the same root at every checkpoint, the same final root and the same witnesses over ranges with empty blocks, a chunk boundary inside a run of empty blocks, a note of ours as the last leaf of a chunk, a start state next to a shard boundary and pruning; the same at the real chunk size over three chunks and over ranges of 9,999, 10,000 and 10,001 blocks from starts at positions 65,533 to 65,536, and the bounds on the checkpoints kept over 50,000 empty blocks.
- `docs/method.md`, the method from end to end (what a verdict is, what is timed, devices and the proposed bars, how a run counts, how a community result is sent, battery), linked from the README limits.
- An SPDX licence line at the top of each file in `proxy/`; the file hashes in `web/endpoints.mjs` follow.
- A line in the README limits: a link fills the endpoint only with an origin of the endpoint table (with a test).
- A test checks that no line of a tracked file carries a review reference (every file except `web/corpus/`, `Cargo.lock`, the licences and the svg and bin files, not only `//` comments), and that each allowed phrase appears only in its own context.
- CI fails if the tracked `web/corpus/synthetic-10k.bin.sha256` is deleted.
- `web/corpus/synthetic-10k.bin.sha256`, the published hash of the synthetic corpus; CI regenerates the corpus and fails if the hash changes.
- A GitHub Actions workflow (`.github/workflows/ci.yml`): `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --release --locked`, the node tests, and the two key checks.
- `SECURITY.md`, `CHANGELOG.md` and a pull request template with an AI disclosure line.
- `rustfmt` and `clippy` in `rust-toolchain.toml`.
- `results/`, the folder for the project's own runs under the protocol (empty today).

### Changed
- The scan's timed stages name the tree state calls of a live row in the README and the docs.
- The README holds what it measures, how to reproduce, results, limits, how to submit and credits; the rest moved to `docs/protocol-details.md`.
- The README gives the page URL, the proxy start and the results folder, and its credits name each crate with its repository.
- The Rust code is formatted with rustfmt, and the clippy warnings are fixed (no change in behaviour).
- `CONTRIBUTING.md` names the commit trailer for AI-assisted commits.
