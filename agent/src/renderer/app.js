/* Monitour Agent — Renderer logic */
const { ipcRenderer } = require('electron');

// --- Elements ---
const enrollView = document.getElementById('enrollView');
const statusView = document.getElementById('statusView');
const deletedView = document.getElementById('deletedView');
const enrollForm = document.getElementById('enrollForm');
const serverUrlInput = document.getElementById('serverUrl');
const enrollTokenInput = document.getElementById('enrollToken');
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

function showInputPrompt(message, title, inputType) {
  return showModal({ title: title || 'Input Required', message, inputType: inputType || 'password', okText: 'Continue', showCancel: true, cancelText: 'Cancel' });
}

// ============================================================
// Enrollment Form
// ============================================================

enrollForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessages();

  const serverUrl = serverUrlInput.value.trim();
  const enrollToken = enrollTokenInput.value.trim();

  if (!serverUrl) {
    showError('Server URL is required.');
    return;
  }

  let url = serverUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> Enrolling…';

  try {
    const result = await ipcRenderer.invoke('enroll', { serverUrl: url, enrollToken: enrollToken || undefined });
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
    initServiceAndPassword();
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
ipcRenderer.on('device-deleted', (_e, data) => {
  enrollView.style.display = 'none';
  statusView.style.display = 'none';
  deletedView.style.display = 'block';
  hideMessages();
});

// --- Re-enroll form ---
const reEnrollForm = document.getElementById('reEnrollForm');
const reEnrollServerUrl = document.getElementById('reEnrollServerUrl');
const reEnrollToken = document.getElementById('reEnrollToken');
const reEnrollBtn = document.getElementById('reEnrollBtn');

reEnrollForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessages();

  const serverUrl = reEnrollServerUrl.value.trim();
  const enrollToken = reEnrollToken.value.trim();
  if (!serverUrl || !enrollToken) return;

  let url = serverUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }

  reEnrollBtn.disabled = true;
  reEnrollBtn.innerHTML = '<span class="spinner"></span> Re-enrolling…';

  try {
    const result = await ipcRenderer.invoke('enroll', { serverUrl: url, enrollToken: enrollToken || undefined });
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
  statusView.style.display = 'block';
  deviceName.textContent = state.deviceName || 'Unknown Device';
  deviceId.textContent = state.deviceId || '—';
  infoServer.textContent = state.serverUrl || '—';
  infoPlatform.textContent = state.platform || '—';
  infoVersion.textContent = state.agentVersion || '0.1.0';
  infoLastSeen.textContent = 'Just now';
}

// ============================================================
// Reset & Re-enroll (password-gated)
// ============================================================

document.getElementById('forgetLink').addEventListener('click', async (e) => {
  e.preventDefault();

  const hasPwd = await ipcRenderer.invoke('is-password-set');
  if (hasPwd) {
    const pwd = await showPasswordPrompt('Enter your settings password to reset and re-enroll this agent.');
    if (pwd === null) return;
    const valid = await ipcRenderer.invoke('verify-password', pwd);
    if (!valid) {
      await showAlert('Incorrect password. Operation cancelled.');
      return;
    }
  } else {
    const ok = await showConfirm('Reset this agent and un-enroll from the server?');
    if (!ok) return;
  }

  await ipcRenderer.invoke('forget');
  enrollView.style.display = 'block';
  statusView.style.display = 'none';
  serverUrlInput.value = '';
  enrollTokenInput.value = '';
  hideMessages();
});

// ============================================================
// Service Management
// ============================================================

async function initServiceAndPassword() {
  try {
    const svc = await ipcRenderer.invoke('service-status');
    const statusEl = document.getElementById('serviceStatusText');
    const installBtn = document.getElementById('installServiceBtn');
    const uninstallBtn = document.getElementById('uninstallServiceBtn');
    if (svc.installed) {
      statusEl.textContent = svc.running ? 'Running' : 'Stopped';
      installBtn.style.display = 'none';
      uninstallBtn.style.display = 'block';
    } else {
      statusEl.textContent = 'Not installed';
      installBtn.style.display = 'block';
      uninstallBtn.style.display = 'none';
    }
  } catch { /* ignore */ }

  try {
    const hasPwd = await ipcRenderer.invoke('is-password-set');
    document.getElementById('passwordStatusText').textContent = hasPwd ? 'Set' : 'Not set';
    document.getElementById('passwordForm').style.display = hasPwd ? 'none' : 'block';
    document.getElementById('removePasswordBtn').style.display = hasPwd ? 'block' : 'none';
  } catch { /* ignore */ }
}

document.getElementById('installServiceBtn').addEventListener('click', async () => {
  const btn = document.getElementById('installServiceBtn');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  const result = await ipcRenderer.invoke('install-service');
  btn.disabled = false;
  btn.textContent = 'Install as Service (Auto-run)';
  if (result.success) {
    await showAlert(result.message, 'Service Installed');
  } else {
    await showAlert('Failed: ' + result.message, 'Service Error');
  }
  await initServiceAndPassword();
});

document.getElementById('uninstallServiceBtn').addEventListener('click', async () => {
  const ok = await showConfirm('Uninstall the service?');
  if (!ok) return;
  const result = await ipcRenderer.invoke('uninstall-service');
  await showAlert(result.message, result.success ? 'Service Uninstalled' : 'Service Error');
  await initServiceAndPassword();
});

// ============================================================
// Password Management (password-gated for change/remove)
// ============================================================

document.getElementById('setPasswordBtn').addEventListener('click', async () => {
  const pwd = document.getElementById('passwordInput').value;
  if (pwd.length < 6) {
    await showAlert('Password must be at least 6 characters.');
    return;
  }
  const result = await ipcRenderer.invoke('set-password', pwd);
  if (result.success) {
    document.getElementById('passwordInput').value = '';
    await initServiceAndPassword();
  } else {
    await showAlert('Failed: ' + result.error);
  }
});

document.getElementById('removePasswordBtn').addEventListener('click', async () => {
  // Require old password first
  const oldPwd = await showPasswordPrompt('Enter your current settings password to remove it.');
  if (oldPwd === null) return;
  const valid = await ipcRenderer.invoke('verify-password', oldPwd);
  if (!valid) {
    await showAlert('Incorrect password. Operation cancelled.');
    return;
  }

  const ok = await showConfirm('Remove the settings password?');
  if (!ok) return;

  await ipcRenderer.invoke('remove-password');
  await initServiceAndPassword();
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

    const dl = await ipcRenderer.invoke('download-update', check.manifest);
    if (!dl.success) {
      await showAlert('Download failed: ' + dl.error);
      return;
    }

    btn.textContent = 'Installing…';
    await ipcRenderer.invoke('apply-update', dl.filepath);
    await showAlert('Update applied. The agent will restart.');
  } catch (err) {
    await showAlert('Update failed: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Now';
  }
});
