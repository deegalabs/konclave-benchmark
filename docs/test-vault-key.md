# The published test vault key: what it reveals

This is the key in `config/test-vault.json`: the test vault of this benchmark, a 2-of-3 made only for it, with a small balance.

A viewing key cannot be withdrawn once published. Anyone holding it can, for the whole life of that vault, past and future:
- see every payment into and out of it, with amounts, destinations it paid, and memos;
- compute its balance;
- recognise its transactions on chain.

It cannot spend. It says nothing about any other vault, because this vault shares no key with one.

So the vault exists only for this benchmark: a new 2-of-3, a very small balance, memos written to be read, never reused. Its key goes in `config/test-vault.json`; `scripts/check-no-keys.mjs` fails if any other viewing key appears in this repository.

A manual check, not done by the code: on a range from the vault's birthday to the tip, `received_zat` minus `spent_in_range_zat` must equal the balance read by `zcash-devtool wallet balance` from a separate wallet.

When the key is published, put the sha256 of its text in `web/test-vault.mjs` (`TEST_KEY_SHA256`): a scan keeps its amounts and note counts, and a row can carry a verdict, only when the key it used has that hash. A test compares the hash with `config/test-vault.json`. A result stores the hash of a typed key, never any part of it.
