// SPDX-License-Identifier: MIT OR Apache-2.0
// Shows the published test key, copied from the release zip by the Pages workflow (test-vault.json next to this page),
// and a button that copies it.
const box = document.getElementById('key');
const copy = document.getElementById('copy');
const status = document.getElementById('copied');
fetch('./test-vault.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((v) => { box.value = v.ufvk; copy.hidden = false; })
  .catch(() => { box.value = 'Not found: open config/test-vault.json in the repository.'; });
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(box.value);
    status.textContent = 'Copied.';
  } catch {
    box.focus();
    box.select();
    status.textContent = 'Selected: copy it with your keyboard or the menu.';
  }
});
