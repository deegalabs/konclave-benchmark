# Security policy

Report a vulnerability through GitHub private vulnerability reporting: the "Report a vulnerability" button on the Security tab of this repository (a private security advisory). Do not open a public issue for it.

In scope: the proxy configuration under `proxy/`, and the scanning and proving code and the scripts of this repository (`src/`, `web/`, `scripts/`).

Out of scope: third-party servers (the light client servers and proxies a run may reach), and the services of GitHub.

The one viewing key in this repository, in `config/test-vault.json`, is published on purpose (see `docs/test-vault-key.md`). Any other key in the tree or the history is a report.
