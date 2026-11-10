# Contributing

This repository follows the [librustzcash style guides](https://github.com/zcash/librustzcash/blob/main/CONTRIBUTING.md#styleguides) for code, commits and pull requests.

- A result is never edited by hand. Every number in a report recomputes from raw JSON with `scripts/summarize.mjs`.
- A new check comes with a test that fails without it.
- Pin versions: the crate line here is the one in `Cargo.lock`.
- No code from a repository without a licence.
