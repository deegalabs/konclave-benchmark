# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project has no released version yet.

## [Unreleased]

Starts at commit 157a510 (the bare note-commitment tree roots of each scan are recorded).

### Added

- `docs/method.md`, the method from end to end (what a verdict is, what is timed, devices and the proposed bars, how a run counts, how a community result is sent, battery), linked from the README limits.
- The scan's timed stages name the tree state calls of a live row in the README and the docs.
- An SPDX licence line at the top of each file in `proxy/`; the file hashes in `web/endpoints.mjs` follow.
- A line in the README limits: a link fills the endpoint only with an origin of the endpoint table (with a test).
- A test checks that comments and test names carry no review references, in every tracked text file (not only `//` comments), and that each allowed phrase appears only in its own context.
- CI fails if the tracked `web/corpus/synthetic-10k.bin.sha256` is deleted.
- `web/corpus/synthetic-10k.bin.sha256`, the published hash of the synthetic corpus; CI regenerates the corpus and fails if the hash changes.
- A GitHub Actions workflow (`.github/workflows/ci.yml`): `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --release --locked`, the node tests, and the two key checks.
- `SECURITY.md`, `CHANGELOG.md` and a pull request template with an AI disclosure line.
- `rustfmt` and `clippy` in `rust-toolchain.toml`.
- `results/`, the folder for the project's own runs under the protocol (empty today).

### Changed
- The README holds what it measures, how to reproduce, results, limits, how to submit and credits; the rest moved to `docs/protocol-details.md`.
- The README gives the page URL, the proxy start and the results folder, and its credits name each crate with its repository.
- The Rust code is formatted with rustfmt, and the clippy warnings are fixed (no change in behaviour).
- `CONTRIBUTING.md` names the commit trailer for AI-assisted commits.
