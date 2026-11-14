/* Monitour Agent — Renderer logic */
const { ipcRenderer } = require('electron');

// --- Elements ---
const enrollView = document.getElementById('enrollView');
const statusView = document.getElementById('statusView');
const deletedView = document.getElementById('deletedView');
const settingsView = document.getElementById('settingsView');
const enrollForm = document.getElementById('enrollForm');
const serverUrlInput = document.getElementById('serverUrl');
const enrollKeyInput = document.getElementById('enrollKey');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');
const successBox = document.getElementById('successBox');

const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const deviceName = document.getElementById('deviceName');
const deviceId = document.getElementById('deviceId');
const infoServer = document.getElementById('infoServer');
const infoPlatform = document.getElementById('infoPlatform');
const infoVersion = document.getElementById('infoVersion');
const infoLastSeen = document.getElementById('infoLastSeen');

// --- Titlebar ---
document.getElementById('btnMin').addEventListener('click', () => ipcRenderer.send('window-minimize'));
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('window-close'));

// ============================================================
// Custom Modal System (replaces native alert/confirm)
// ============================================================

function showModal({ title, message, inputType, inputValue, okText, okClass, showCancel, cancelText }) {
  return new Promise((resolve) => {
    const container = document.getElementById('modalContainer');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    overlay.innerHTML = `
      <div class="modal-box">
        <h3>${title}</h3>
        ${message ? `<p>${message}</p>` : ''}
        ${inputType ? `<input type="${inputType}" id="modalInput" value="${inputValue || ''}" autocomplete="off" />` : ''}
        <div class="modal-actions">
          ${showCancel ? `<button class="btn modal-btn-cancel" id="modalCancel">${cancelText || 'Cancel'}</button>` : ''}
          <button class="btn ${okClass || 'modal-btn-ok'}" id="modalOk">${okText || 'OK'}</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);

    const input = overlay.querySelector('#modalInput');
    const okBtn = overlay.querySelector('#modalOk');
    const cancelBtn = overlay.querySelector('#modalCancel');

    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
        if (e.key === 'Escape') { e.preventDefault(); (cancelBtn || okBtn).click(); }
      });
    }

    okBtn.addEventListener('click', () => {
      const val = input ? input.value : true;
      overlay.remove();
      resolve(val);
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
    }

    // Click outside to cancel
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
  });
}

function showAlert(message, title) {
  return showModal({ title: title || 'Monitour Agent', message, okText: 'OK' });
}

function showConfirm(message, title) {
  return showModal({ title: title || 'Confirm', message, okText: 'Confirm', showCancel: true, cancelText: 'Cancel' });
}

function showPasswordPrompt(message, title) {
  return showModal({ title: title || 'Authentication Required', message, inputType: 'password', okText: 'Verify', showCancel: true, cancelText: 'Cancel' });
}

/**
 * Ask for the settings password when one is set. Returns null when the user
 * cancels (the operation must abort) or a string to pass to the main process
 * (null when no password is set — the main-side gate is inactive then).
 */
async function gatePassword(message) {
  const hasPwd = await ipcRenderer.invoke('is-password-set');
  if (!hasPwd) return { ok: true, password: null };
  const pwd = await showPasswordPrompt(message || 'Enter your settings password to continue.');
  if (pwd === null) return { ok: false };
  return { ok: true, password: pwd };
}

function showSettingsError(msg) {
  const box = document.getElementById('settingsErrorBox');
  const ok = document.getElementById('settingsSuccessBox');
  box.textContent = msg;
  box.style.display = 'block';
  ok.style.display = 'none';
}

function showSettingsSuccess(msg) {
  const box = document.getElementById('settingsSuccessBox');
  const err = document.getElementById('settingsErrorBox');
  box.textContent = msg;
  box.style.display = 'block';
  err.style.display = 'none';
}

// ============================================================
// Enrollment Form
// ============================================================

enrollForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessages();

  const serverUrl = serverUrlInput.value.trim();
  const enrollKey = enrollKeyInput.value.trim();

  if (!serverUrl) {
    showError('Server URL is required.');
    return;
  }
  if (!enrollKey) {
    showError('Enrollment key is required.');
    return;
  }

  let url = serverUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }

  const gate = await gatePassword('Enter your settings password to enroll this agent.');
  if (!gate.ok) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> Enrolling…';

  try {
    const result = await ipcRenderer.invoke('enroll', gate.password, { serverUrl: url, enrollKey: enrollKey || undefined });
    if (result.success) {
      showSuccess('Enrolled successfully! Connecting…');
      setTimeout(() => showStatusView(result.state), 500);
    } else {
      showError(result.error || 'Enrollment failed.');
    }
  } catch (err) {
    showError(err.message || 'Unexpected error during enrollment.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Connect & Enroll';
  }
});

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
  successBox.style.display = 'none';
}

function showSuccess(msg) {
  successBox.textContent = msg;
  successBox.style.display = 'block';
  errorBox.style.display = 'none';
}

function hideMessages() {
  errorBox.style.display = 'none';
  successBox.style.display = 'none';
}

// ============================================================
// App State
// ============================================================

ipcRenderer.send('app-ready');

ipcRenderer.on('app-state', (_e, state) => {
  if (state.enrolled) {
    showStatusView(state);
    initUpdateChecker();
  } else {
    if (state.serverUrl) serverUrlInput.value = state.serverUrl;
  }
});

let wasConnected = false;
ipcRenderer.on('agent-status', (_e, data) => {
  if (data.connected) {
    wasConnected = true;
    statusDot.className = 'status-dot online';
    statusLabel.textContent = 'Connected';
  } else if (wasConnected) {
    statusDot.className = 'status-dot offline';
    statusLabel.textContent = 'Disconnected — reconnecting…';
  } else {
    statusDot.className = 'status-dot connecting';
    statusLabel.textContent = 'Connecting…';
  }
  if (data.lastSeen) infoLastSeen.textContent = new Date(data.lastSeen).toLocaleTimeString();
});

// --- Device deleted from server ---
ipcRenderer.on('device-deleted', (_e) => {
  enrollView.style.display = 'none';
  statusView.style.display = 'none';
  settingsView.style.display = 'none';
  deletedView.style.display = 'block';
  hideMessages();
});

// --- Re-enroll form ---
const reEnrollForm = document.getElementById('reEnrollForm');
const reEnrollServerUrl = document.getElementById('reEnrollServerUrl');
const reEnrollKeyInput = document.getElementById('reEnrollKey');
const reEnrollBtn = document.getElementById('reEnrollBtn');

reEnrollForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessages();

  const serverUrl = reEnrollServerUrl.value.trim();
  const enrollKey = reEnrollKeyInput.value.trim();
  if (!serverUrl || !enrollKey) return;

  let url = serverUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }

  const gate = await gatePassword('Enter your settings password to re-enroll this agent.');
  if (!gate.ok) return;

  reEnrollBtn.disabled = true;
  reEnrollBtn.innerHTML = '<span class="spinner"></span> Re-enrolling…';

  try {
    const result = await ipcRenderer.invoke('enroll', gate.password, { serverUrl: url, enrollKey });
    if (result.success) {
      showSuccess('Re-enrolled successfully! Connecting…');
      deletedView.style.display = 'none';
      setTimeout(() => showStatusView(result.state), 500);
    } else {
      showError(result.error || 'Re-enrollment failed.');
    }
  } catch (err) {
    showError(err.message || 'Unexpected error.');
  } finally {
    reEnrollBtn.disabled = false;
    reEnrollBtn.textContent = 'Re-Enroll';
  }
});

function showStatusView(state) {
  enrollView.style.display = 'none';
  deletedView.style.display = 'none';
  settingsView.style.display = 'none';
  statusView.style.display = 'block';
  deviceName.textContent = state.deviceName || 'Unknown Device';
  deviceId.textContent = state.deviceId || '—';
  infoServer.textContent = state.serverUrl || '—';
  infoPlatform.textContent = state.platform || '—';
  infoVersion.textContent = state.agentVersion || '0.1.0';
  infoLastSeen.textContent = 'Just now';
}

// ============================================================
// Settings view
// ============================================================

function switchSettingsTab(name) {
  document.querySelectorAll('.settings-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === name);
  });
  document.querySelectorAll('.settings-panel').forEach((el) => {
    el.style.display = el.id === `tab-${name}` ? 'block' : 'none';
  });
}

document.querySelectorAll('.settings-tab').forEach((el) => {
  el.addEventListener('click', () => switchSettingsTab(el.dataset.tab));
});

document.getElementById('settingsLink').addEventListener('click', async (e) => {
  e.preventDefault();
  // The whole settings view is password-protected when a password is set
  const hasPwd = await ipcRenderer.invoke('is-password-set');
  if (hasPwd) {
    const pwd = await showPasswordPrompt('Enter your settings password to open settings.');
    if (pwd === null) return;
    const valid = await ipcRenderer.invoke('verify-password', pwd);
    if (!valid) {
      await showAlert('Incorrect password.', 'Access Denied');
      return;
    }
  }
  statusView.style.display = 'none';
  settingsView.style.display = 'block';
  switchSettingsTab('connection');
  await refreshSettingsView();
});

document.getElementById('backToStatusLink').addEventListener('click', (e) => {
  e.preventDefault();
  settingsView.style.display = 'none';
  statusView.style.display = 'block';
});

async function refreshSettingsView() {
  document.getElementById('settingsErrorBox').style.display = 'none';
  document.getElementById('settingsSuccessBox').style.display = 'none';
  try {
    const s = await ipcRenderer.invoke('get-settings');
    document.getElementById('settingsServerUrl').value = s.serverUrl || '';
    document.getElementById('settingsDeviceName').value = s.deviceName || '';
    document.getElementById('settingsVersion').textContent = s.agentVersion || '—';
    document.getElementById('autoUpdateToggle').checked = s.autoUpdate !== false;
    document.getElementById('showInTrayToggle').checked = s.showInTray !== false;
    document.getElementById('passwordStatusText').textContent = s.passwordSet ? 'Set' : 'Not set';
    document.getElementById('passwordForm').style.display = s.passwordSet ? 'none' : 'block';
    document.getElementById('changePasswordBtn').style.display = s.passwordSet ? 'block' : 'none';
    document.getElementById('removePasswordBtn').style.display = s.passwordSet ? 'block' : 'none';

    renderServiceStatus(s.serviceStatus);
  } catch { /* ignore */ }
}

// ============================================================
// Connection — save settings; re-enrolls only when the server
// URL or enrollment key changed (name-only changes just save)
// ============================================================

document.getElementById('saveServerUrlBtn').addEventListener('click', async () => {
  const raw = document.getElementById('settingsServerUrl').value.trim();
  if (!raw) {
    showSettingsError('Server URL is required.');
    return;
  }
  let url = raw;
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;

  const enrollKey = document.getElementById('settingsEnrollKey').value.trim();
  const newName = document.getElementById('settingsDeviceName').value.trim();

  let current = {};
  try {
    current = await ipcRenderer.invoke('get-settings');
  } catch { /* treat as empty */ }
  const urlChanged = url !== (current.serverUrl || '');
  const keyGiven = enrollKey.length > 0;
  const nameChanged = newName.length > 0 && newName !== (current.deviceName || '');

  if (!urlChanged && !keyGiven && !nameChanged) {
    showSettingsSuccess('Nothing to save.');
    return;
  }

  const gate = await gatePassword('Enter your settings password to apply settings changes.');
  if (!gate.ok) return;

  // Name-only change: save it without touching the device identity
  if (!urlChanged && !keyGiven) {
    const result = await ipcRenderer.invoke('update-device-name', gate.password, newName);
    if (result.success) {
      showSettingsSuccess('Device name saved.');
      await refreshSettingsView();
    } else {
      showSettingsError(result.error || 'Rename failed.');
    }
    return;
  }

  // Server URL (or a new key) changed → confirm, then full re-enroll
  const ok = await showConfirm(
    'Changing the server URL re-registers this device with a NEW identity. ' +
    'The old server keeps a stale device entry. Continue?',
    'Save & Re-enroll',
  );
  if (!ok) return;

  const btn = document.getElementById('saveServerUrlBtn');
  btn.disabled = true;
  btn.textContent = 'Re-enrolling…';
  try {
    const result = await ipcRenderer.invoke('change-server-url', gate.password, url, keyGiven ? enrollKey : undefined);
    if (result.success) {
      let msg = 'Re-enrolled to ' + url;
      if (nameChanged) {
        const rename = await ipcRenderer.invoke('update-device-name', gate.password, newName);
        msg = rename.success ? `${msg} · device named "${newName}"` : `${msg} (name save failed)`;
      }
      showSettingsSuccess(msg);
      await refreshSettingsView();
    } else {
      showSettingsError(result.error || 'Re-enrollment failed.');
    }
  } catch (err) {
    showSettingsError(err.message || 'Unexpected error.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Re-enroll';
  }
});

// ============================================================
// Service Management
// ============================================================

function renderServiceStatus(svc) {
  const statusEl = document.getElementById('serviceStatusText');
  const installBtn = document.getElementById('installServiceBtn');
  const uninstallBtn = document.getElementById('uninstallServiceBtn');
  if (!svc) return;
  if (svc.installed) {
    statusEl.textContent = svc.running ? 'Running' : 'Stopped';
    installBtn.style.display = 'none';
    uninstallBtn.style.display = 'block';
  } else {
    statusEl.textContent = 'Not installed';
    installBtn.style.display = 'block';
    uninstallBtn.style.display = 'none';
  }
}

document.getElementById('installServiceBtn').addEventListener('click', async () => {
  const gate = await gatePassword('Enter your settings password to install the service.');
  if (!gate.ok) return;

  const btn = document.getElementById('installServiceBtn');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  const result = await ipcRenderer.invoke('install-service', gate.password);
  btn.disabled = false;
  btn.textContent = 'Install as Service (Auto-run)';
  renderServiceStatus(result.serviceStatus);
  if (result.success) {
    await showAlert(result.message, 'Service Installed');
  } else {
    await showAlert('Failed: ' + result.message, 'Service Error');
  }
  await refreshSettingsView();
});

document.getElementById('uninstallServiceBtn').addEventListener('click', async () => {
  const gate = await gatePassword('Enter your settings password to uninstall the service.');
  if (!gate.ok) return;
  const ok = await showConfirm('Uninstall the service?');
  if (!ok) return;
  const result = await ipcRenderer.invoke('uninstall-service', gate.password);
  renderServiceStatus(result.serviceStatus);
  await showAlert(result.message, result.success ? 'Service Uninstalled' : 'Service Error');
  await refreshSettingsView();
});

// ============================================================
// Password Management (main process is the real gate)
// ============================================================

document.getElementById('setPasswordBtn').addEventListener('click', async () => {
  const pwd = document.getElementById('passwordInput').value;
  if (pwd.length < 6) {
    await showAlert('Password must be at least 6 characters.');
    return;
  }
  // First set needs no password; the main handler enforces that too.
  const result = await ipcRenderer.invoke('set-password', null, pwd);
  if (result.success) {
    document.getElementById('passwordInput').value = '';
    await refreshSettingsView();
  } else {
    await showAlert('Failed: ' + result.error);
  }
});

document.getElementById('changePasswordBtn').addEventListener('click', async () => {
  const oldPwd = await showPasswordPrompt('Enter your current settings password.');
  if (oldPwd === null) return;
  const newPwd = await showPasswordPrompt('Enter the new settings password.', 'New Password');
  if (newPwd === null) return;
  if (newPwd.length < 6) {
    await showAlert('Password must be at least 6 characters.');
    return;
  }
  const result = await ipcRenderer.invoke('set-password', oldPwd, newPwd);
  if (result.success) {
    await refreshSettingsView();
  } else {
    await showAlert('Failed: ' + result.error);
  }
});

document.getElementById('removePasswordBtn').addEventListener('click', async () => {
  const gate = await gatePassword('Enter your current settings password to remove it.');
  if (!gate.ok) return;

  const ok = await showConfirm('Remove the settings password?');
  if (!ok) return;

  const result = await ipcRenderer.invoke('remove-password', gate.password);
  if (result.success) {
    await refreshSettingsView();
  } else {
    await showAlert('Failed: ' + result.error);
  }
});

// ============================================================
// Auto-Update
// ============================================================

async function initUpdateChecker() {
  try {
    const result = await ipcRenderer.invoke('check-for-updates');
    if (result.hasUpdate && result.manifest) {
      document.getElementById('updateBanner').style.display = 'flex';
      document.getElementById('updateVersion').textContent = result.manifest.version;
    }
  } catch { /* ignore */ }
}

async function runUpdate(manifest) {
  const gate = await gatePassword('Enter your settings password to install the update.');
  if (!gate.ok) return;

  const dl = await ipcRenderer.invoke('download-update', gate.password, manifest);
  if (!dl.success) {
    await showAlert('Download failed: ' + dl.error);
    return;
  }
  await ipcRenderer.invoke('apply-update', gate.password, dl.filepath);
  await showAlert('Update applied. The agent will restart.');
}

document.getElementById('updateNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('updateNowBtn');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const check = await ipcRenderer.invoke('check-for-updates');
    if (!check.manifest) {
      await showAlert('No update available.');
      return;
    }
    await runUpdate(check.manifest);
  } catch (err) {
    await showAlert('Update failed: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Now';
  }
});

document.getElementById('checkUpdatesBtn').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('check-for-updates');
  const btn = document.getElementById('settingsUpdateBtn');
  if (result.hasUpdate && result.manifest) {
    btn.style.display = 'block';
    btn.dataset.version = result.manifest.version;
    showSettingsSuccess('Update available: ' + result.manifest.version);
  } else {
    btn.style.display = 'none';
    showSettingsSuccess('Agent is up to date.');
  }
});

document.getElementById('settingsUpdateBtn').addEventListener('click', async () => {
  const btn = document.getElementById('settingsUpdateBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const check = await ipcRenderer.invoke('check-for-updates');
    if (!check.manifest) {
      showSettingsError('No update available.');
      return;
    }
    await runUpdate(check.manifest);
  } catch (err) {
    showSettingsError(err.message || 'Update failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download & Install';
  }
});

document.getElementById('autoUpdateToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  const gate = await gatePassword('Enter your settings password to change update settings.');
  if (!gate.ok) {
    e.target.checked = !enabled;
    return;
  }
  const result = await ipcRenderer.invoke('set-auto-update', gate.password, enabled);
  if (!result.success) {
    e.target.checked = !enabled;
    showSettingsError(result.error || 'Failed to change update setting.');
  } else {
    showSettingsSuccess('Update preference saved.');
  }
});

document.getElementById('showInTrayToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  const gate = await gatePassword('Enter your settings password to change the tray setting.');
  if (!gate.ok) {
    e.target.checked = !enabled;
    return;
  }
  const result = await ipcRenderer.invoke('set-show-in-tray', gate.password, enabled);
  if (!result || !result.success) {
    e.target.checked = !enabled;
    showSettingsError((result && result.error) || 'Failed to change tray setting.');
  } else {
    showSettingsSuccess(enabled ? 'Tray icon shown.' : 'Tray icon hidden.');
  }
});

// ============================================================
// Quit agent (password-gated when a password is set)
// ============================================================

document.getElementById('quitAgentBtn').addEventListener('click', async () => {
  const gate = await gatePassword('Enter your settings password to quit the agent.');
  if (!gate.ok) return;
  const result = await ipcRenderer.invoke('quit-app', gate.password);
  if (!result || !result.success) {
    await showAlert((result && result.error) || 'Quit failed', 'Quit');
  }
});

// Tray menu → Quit with a password set: main surfaces this prompt
ipcRenderer.on('prompt-quit-password', async () => {
  const pwd = await showPasswordPrompt('Enter your settings password to quit the agent.');
  if (pwd === null) return; // cancel — the agent keeps running
  const result = await ipcRenderer.invoke('quit-app', pwd);
  if (!result || !result.success) {
    await showAlert((result && result.error) || 'Quit failed', 'Quit');
  }
});
