# Contributing

This repository follows the [librustzcash style guides](https://github.com/zcash/librustzcash/blob/main/CONTRIBUTING.md#styleguides) for code, commits and pull requests.

- A result is never edited by hand. Every number in a report recomputes from raw JSON with `scripts/summarize.mjs`.
- A new check comes with a test that fails without it.
- Pin versions: the crate line here is the one in `Cargo.lock`.
- No code from a repository without a licence.

## Commits and AI assistance

- A commit made with the help of an AI assistant ends with exactly this trailer, with no model name:
  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```
- The pull request fills in its AI disclosure line (see the template).
- Before you open a pull request run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --release`, `node --test tests/node.test.mjs tests/charts.test.mjs`, `node scripts/check-no-keys.mjs` and `node scripts/check-history.mjs`. CI runs the same, with `--locked` on clippy and the Rust tests.
