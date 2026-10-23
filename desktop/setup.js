const form = document.getElementById('form');
const url = document.getElementById('url');
const share = document.getElementById('share');
const error = document.getElementById('error');
const go = document.getElementById('go');

window.haulDesktop.getConfig().then((config) => {
  if (!config) return;
  if (config.remoteUrl) url.value = config.remoteUrl;
  share.checked = Boolean(config.share);
  const radio = form.querySelector(`input[value="${config.mode}"]`);
  if (radio) radio.checked = true;
});

url.addEventListener('focus', () => { form.querySelector('input[value="remote"]').checked = true; });
share.addEventListener('change', () => { if (share.checked) form.querySelector('input[value="local"]').checked = true; });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  go.disabled = true;
  go.textContent = 'Connecting…';
  const mode = form.querySelector('input[name="mode"]:checked').value;
  try {
    await window.haulDesktop.saveConfig({ mode, remoteUrl: url.value, share: share.checked });
  } catch (failure) {
    error.textContent = String(failure.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    go.disabled = false;
    go.textContent = 'Continue';
  }
});
