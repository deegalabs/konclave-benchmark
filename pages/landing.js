// SPDX-License-Identifier: MIT OR Apache-2.0
// Shows the published test key, copied from the release zip by the Pages workflow (test-vault.json next to this page).
fetch('./test-vault.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((v) => { document.getElementById('key').value = v.ufvk; })
  .catch(() => { document.getElementById('key').value = 'Not found: open config/test-vault.json in the repository.'; });
