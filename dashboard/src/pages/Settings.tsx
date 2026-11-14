import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { api } from '../api/client';
import { useAuthStore } from '../store';
import { useModal } from '../components/Modal';
import type { EnrollmentKeyInfo, InstallerInfo, UpdateManifest } from '@monitour/shared';

const SLOTS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'] as const;
const EXPECTED_EXT: Record<string, string> = { win32: '.exe', darwin: '.dmg', linux: '.AppImage' };

export function SettingsPage() {
  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Settings</h2>
      <EnrollmentSection />
      <AgentSoftwareSection />
    </div>
  );
}

// ============================================================
// Enrollment — keys are the only credential
// ============================================================

function EnrollmentSection() {
  const { user } = useAuthStore();
  const modal = useModal();
  const [keys, setKeys] = useState<EnrollmentKeyInfo[]>([]);
  const [newKey, setNewKey] = useState<EnrollmentKeyInfo | null>(null);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [labels, setLabels] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { keys: list } = await api.get<{ keys: EnrollmentKeyInfo[] }>('/enrollment/keys');
      setKeys(list);
    } catch {
      // non-admin may not see keys
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createKey() {
    setError('');
    setLoading(true);
    try {
      const result = await api.post<EnrollmentKeyInfo>('/enrollment/keys', {
        name: name || `key-${Date.now()}`,
        group: group || null,
        labels: labels ? labels.split(',').map((s) => s.trim()).filter(Boolean) : [],
        maxUses: maxUses ? Number(maxUses) : null,
      });
      setNewKey(result);
      setName('');
      setGroup('');
      setLabels('');
      setMaxUses('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setLoading(false);
    }
  }

  async function revokeKey(id: string) {
    const ok = await modal.confirm({
      title: 'Revoke Enrollment Key',
      message: 'Future agents will no longer be able to enroll with this key. Existing devices are unaffected. Continue?',
      okText: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/enrollment/keys/${id}/revoke`);
      await load();
    } catch (err) {
      await modal.alert({ title: 'Error', message: 'Failed to revoke: ' + (err instanceof Error ? err.message : 'Unknown error') });
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <h3 className="card-title">Enrollment</h3>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {user?.role !== 'admin' ? 'Admin access required' : ''}
        </span>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
        Enrollment keys are the only credential an agent needs — embedded in agent packages or
        pasted into the agent manually. Use <strong>Max uses = 1</strong> for a single-use key.
        Revoking blocks future enrollments; existing devices are unaffected.
      </p>

      {error && <div className="error-msg">{error}</div>}

      {user?.role === 'admin' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <input type="text" placeholder="Key name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 150px' }} />
          <input type="text" placeholder="Group (optional)" value={group} onChange={(e) => setGroup(e.target.value)} style={{ flex: '1 1 120px' }} />
          <input type="text" placeholder="Labels, comma-sep" value={labels} onChange={(e) => setLabels(e.target.value)} style={{ flex: '1 1 120px' }} />
          <input type="number" placeholder="Max uses" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} style={{ width: 100 }} />
          <button className="btn btn-primary" onClick={() => void createKey()} disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create Key'}
          </button>
        </div>
      )}

      {newKey && (
        <div style={{ background: 'rgba(63, 185, 80, 0.1)', border: '1px solid var(--success)', borderRadius: 'var(--radius-sm)', padding: 16, marginBottom: 16 }}>
          <p style={{ fontWeight: 600, marginBottom: 8, color: 'var(--success)' }}>
            Key created — copy it now, it won't be shown again:
          </p>
          <code style={{ display: 'block', background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', fontSize: 13 }}>
            {newKey.key}
          </code>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => void navigator.clipboard.writeText(newKey.key)}>
            Copy to Clipboard
          </button>
        </div>
      )}

      {keys.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Group</th>
              <th>Uses</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td><code style={{ fontSize: 12 }}>{k.key}</code></td>
                <td>{k.name}</td>
                <td>{k.group ?? '—'}</td>
                <td style={{ fontSize: 13 }}>{k.useCount}{k.maxUses !== null ? ` / ${k.maxUses}` : ''}</td>
                <td>
                  <span style={{ color: k.revokedAt ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>
                    {k.revokedAt ? 'Revoked' : 'Active'}
                  </span>
                </td>
                <td>
                  {!k.revokedAt && (
                    <button className="btn btn-danger btn-sm" onClick={() => void revokeKey(k.id)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ============================================================
// Agent Software — installer slots serve BOTH enrollment
// packages (new devices) and updates (existing devices)
// ============================================================

function AgentSoftwareSection() {
  const { user } = useAuthStore();
  const modal = useModal();
  const [keys, setKeys] = useState<EnrollmentKeyInfo[]>([]);
  const [available, setAvailable] = useState<Record<string, InstallerInfo | null>>({});
  const [manifests, setManifests] = useState<Record<string, UpdateManifest>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Row action: inline form below the slot row
  const [action, setAction] = useState<{ slot: string; kind: 'package' | 'publish' } | null>(null);
  const [keyId, setKeyId] = useState('');
  const [installService, setInstallService] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Upload: one hidden file input, targeted at a slot
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ slot: string; name: string; percent: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { keys: list } = await api.get<{ keys: EnrollmentKeyInfo[] }>('/enrollment/keys');
      const active = list.filter((k) => !k.revokedAt);
      setKeys(active);
      if (active.length > 0) setKeyId((prev) => prev || active[0].id);
    } catch { /* non-admin */ }
    try {
      const data = await api.get<{ available: Record<string, InstallerInfo | null> }>('/agent/packages/available');
      setAvailable(data.available);
    } catch { /* ignore */ }
    try {
      const data = await api.get<{ manifests: Record<string, UpdateManifest> }>('/agent/updates');
      setManifests(data.manifests);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function splitSlot(slot: string): { platform: string; arch: string } {
    const [platform, arch] = slot.split('-');
    return { platform, arch };
  }

  // ---- Upload / replace ----
  function pickUpload(slot: string) {
    setUploadTarget(slot);
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  async function handleUploadFile(file: File) {
    const slot = uploadTarget;
    if (!slot) return;
    const { platform, arch } = splitSlot(slot);
    if (!file.name.toLowerCase().endsWith(EXPECTED_EXT[platform].toLowerCase())) {
      setError(`${file.name} doesn't look like a ${EXPECTED_EXT[platform]} installer for ${platform}.`);
      setUploadTarget(null);
      return;
    }
    setError('');
    setNotice('');
    setBusy(true);
    setUploadProgress({ slot, name: file.name, percent: 0 });
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('platform', platform);
      formData.append('arch', arch);
      const result = await api.upload<{ installer: InstallerInfo; replaced: string[] }>(
        '/agent/packages/installers',
        formData,
        (percent) => setUploadProgress((prev) => (prev ? { ...prev, percent } : prev)),
      );
      setNotice(`Uploaded ${result.installer.name} to ${slot}` + (result.replaced.length ? ` (replaced ${result.replaced.join(', ')})` : ''));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      setUploadProgress(null);
      setUploadTarget(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // ---- Download the raw installer (manual install + key paste) ----
  async function downloadInstaller(slot: string) {
    const { platform, arch } = splitSlot(slot);
    const info = available[slot];
    setError('');
    try {
      await api.downloadGet(`/agent/packages/installers/${platform}/${arch}`, info?.name || `monitour-agent-${slot}`);
      setNotice(`Downloaded ${info?.name ?? 'installer'} — run it on the target machine, then paste the server URL and an enrollment key.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  // ---- Download enrollment package ----
  async function downloadPackage(slot: string) {
    const { platform, arch } = splitSlot(slot);
    setError('');
    setBusy(true);
    try {
      await api.download('/agent/packages', {
        platform,
        arch,
        enrollmentKeyId: keyId,
        installService,
        autoUpdate,
      }, `monitour-agent-${slot}.zip`);
      setNotice(`Package downloaded for ${slot}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate package');
    } finally {
      setBusy(false);
    }
  }

  // ---- Publish as update ----
  async function publishUpdate(slot: string) {
    const { platform, arch } = splitSlot(slot);
    if (!version.trim()) {
      setError('Version is required to publish an update.');
      return;
    }
    if (manifests[slot]) {
      const ok = await modal.confirm({
        title: 'Republish Update',
        message: `${slot} already has v${manifests[slot].version} published. Replace it with v${version.trim()}?`,
        okText: 'Republish',
      });
      if (!ok) return;
    }
    setError('');
    setBusy(true);
    try {
      await api.post('/agent/updates/publish', { platform, arch, version: version.trim(), notes: notes.trim() || undefined });
      setNotice(`Published v${version.trim()} as the update for ${slot}`);
      setAction(null);
      setVersion('');
      setNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  }

  // ---- Delete installer / unpublish ----
  async function deleteInstaller(slot: string) {
    const ok = await modal.confirm({
      title: 'Delete Installer',
      message: `Remove the installer from ${slot}? Published updates are copies and keep working until unpublished.`,
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const { platform, arch } = splitSlot(slot);
    try {
      await api.delete(`/agent/packages/installers/${platform}/${arch}`);
      await load();
    } catch (err) {
      await modal.alert({ title: 'Error', message: 'Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error') });
    }
  }

  async function unpublish(slot: string) {
    const ok = await modal.confirm({
      title: 'Unpublish Update',
      message: `Remove the published update for ${slot}? Agents will stop seeing it.`,
      okText: 'Unpublish',
      danger: true,
    });
    if (!ok) return;
    const { platform, arch } = splitSlot(slot);
    try {
      await api.delete(`/agent/updates/${platform}/${arch}`);
      await load();
    } catch (err) {
      await modal.alert({ title: 'Error', message: 'Failed to unpublish: ' + (err instanceof Error ? err.message : 'Unknown error') });
    }
  }

  if (user?.role !== 'admin') {
    return (
      <div className="card">
        <div className="card-header"><h3 className="card-title">Agent Software</h3></div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Admin access required</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Agent Software</h3>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
        One installer per slot serves both purposes: <strong>Download package</strong> builds a
        pre-configured zip for enrolling <em>new</em> devices (zero-input install), while{' '}
        <strong>Publish update</strong> lets <em>existing</em> agents self-upgrade. Upload an
        installer once, use it for both. Build installers on their target OS (see deploy/README.md).
      </p>

      {error && <div className="error-msg" style={{ marginBottom: 8 }}>{error}</div>}
      {notice && <div className="success-msg" style={{ marginBottom: 8 }}>{notice}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept=".exe,.dmg,.AppImage"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUploadFile(f);
        }}
      />

      <table className="data-table">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Installer</th>
            <th>Size</th>
            <th>Published</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {SLOTS.map((slot) => {
            const info = available[slot];
            const published = manifests[slot];
            return (
              <Fragment key={slot}>
                <tr>
                  <td><code style={{ fontSize: 12 }}>{slot}</code></td>
                  <td style={{ fontSize: 13 }}>
                    {info ? info.name : <span style={{ color: 'var(--text-muted)' }}>missing</span>}
                  </td>
                  <td style={{ fontSize: 13 }}>{info ? `${(info.size / 1024 / 1024).toFixed(1)} MB` : '—'}</td>
                  <td style={{ fontSize: 13 }}>
                    {published ? `v${published.version}` : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => pickUpload(slot)}>
                      {uploadTarget === slot && busy ? 'Uploading…' : uploadTarget === slot ? '…' : info ? 'Replace' : 'Upload'}
                    </button>{' '}
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!info || busy}
                      title="Download the raw installer for a manual install (agent asks for the enrollment key)"
                      onClick={() => void downloadInstaller(slot)}
                    >
                      Download
                    </button>{' '}
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={!info || keys.length === 0 || busy}
                      title={keys.length === 0 ? 'Create an enrollment key first' : 'Download a pre-configured package for new devices'}
                      onClick={() => setAction(action?.slot === slot && action.kind === 'package' ? null : { slot, kind: 'package' })}
                    >
                      Package
                    </button>{' '}
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!info || busy}
                      title="Publish this installer as the self-update for existing agents"
                      onClick={() => setAction(action?.slot === slot && action.kind === 'publish' ? null : { slot, kind: 'publish' })}
                    >
                      Publish
                    </button>{' '}
                    {info && (
                      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void deleteInstaller(slot)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
                {action?.slot === slot && (
                  <tr style={{ background: 'var(--bg-tertiary)' }}>
                    <td colSpan={5} style={{ background: 'var(--bg-tertiary)' }}>
                      {action.kind === 'package' ? (
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                          <strong style={{ fontSize: 13 }}>Enrollment package for {slot}</strong>
                          <select value={keyId} onChange={(e) => setKeyId(e.target.value)} style={{ minWidth: 180 }}>
                            {keys.map((k) => (
                              <option key={k.id} value={k.id}>{k.name} ({k.key.slice(0, 8)}…)</option>
                            ))}
                          </select>
                          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="checkbox" checked={installService} onChange={(e) => setInstallService(e.target.checked)} />
                            Install as service
                          </label>
                          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} />
                            Auto-update
                          </label>
                          <button className="btn btn-primary btn-sm" disabled={busy || !keyId} onClick={() => void downloadPackage(slot)}>
                            {busy ? 'Working…' : 'Download Zip'}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setAction(null)}>Cancel</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                          <strong style={{ fontSize: 13 }}>Publish {slot} as update</strong>
                          <input
                            type="text"
                            placeholder="Version (e.g. 0.3.0)"
                            value={version}
                            onChange={(e) => setVersion(e.target.value)}
                            style={{ width: 130 }}
                          />
                          <input
                            type="text"
                            placeholder="Notes (optional)"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            style={{ flex: '1 1 200px' }}
                          />
                          <button className="btn btn-primary btn-sm" disabled={busy || !version.trim()} onClick={() => void publishUpdate(slot)}>
                            {busy ? 'Working…' : 'Publish'}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setAction(null)}>Cancel</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {uploadProgress && (
        <div className="progress-row">
          <span>
            Uploading {uploadProgress.name} → {uploadProgress.slot} — {uploadProgress.percent}%
          </span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${uploadProgress.percent}%` }} />
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
        Upload replaces any existing installer in the slot. Published updates are independent
        copies — deleting a slot installer does not affect them.
      </div>

      {Object.keys(manifests).length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>Published updates</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Version</th>
                <th>File</th>
                <th>Notes</th>
                <th>Published</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(manifests).map(([slot, m]) => (
                <tr key={slot}>
                  <td><code style={{ fontSize: 12 }}>{slot}</code></td>
                  <td>v{m.version}</td>
                  <td style={{ fontSize: 13 }}>{m.filename}</td>
                  <td style={{ fontSize: 13 }}>{m.notes || '—'}</td>
                  <td style={{ fontSize: 13 }}>{new Date(m.publishedAt).toLocaleString()}</td>
                  <td>
                    <button className="btn btn-danger btn-sm" onClick={() => void unpublish(slot)}>Unpublish</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
