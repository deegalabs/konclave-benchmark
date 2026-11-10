# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project has no released version yet.

## [Unreleased]

Starts at commit 157a510 (the bare note-commitment tree roots of each scan are recorded).

### Added
- A GitHub Actions workflow (`.github/workflows/ci.yml`): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --release`, the node tests, and the two key checks.
- `SECURITY.md`, `CHANGELOG.md` and a pull request template with an AI disclosure line.
- `rustfmt` and `clippy` in `rust-toolchain.toml`.

### Changed
- The README holds what it measures, how to reproduce, results, limits, how to submit and credits; the rest moved to `docs/protocol-details.md`.
- The Rust code is formatted with rustfmt, and the clippy warnings are fixed (no change in behaviour).
- `CONTRIBUTING.md` names the commit trailer for AI-assisted commits.
