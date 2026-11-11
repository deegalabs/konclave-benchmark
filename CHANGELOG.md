# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project has no released version yet.

## [Unreleased]

Starts at commit 157a510 (the bare note-commitment tree roots of each scan are recorded).

### Added

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
