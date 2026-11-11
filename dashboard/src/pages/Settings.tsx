import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuthStore } from '../store';
import { useModal } from '../components/Modal';

interface TokenInfo {
  token: string;
  fullToken: string;
  label: string;
  expiresAt: string;
  used: boolean;
}

export function SettingsPage() {
  const { user } = useAuthStore();
  const modal = useModal();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [enrollmentMode, setEnrollmentMode] = useState<'open' | 'locked'>('locked');

  useEffect(() => {
    loadTokens();
    loadEnrollmentMode();
  }, []);

  async function loadEnrollmentMode() {
    try {
      const { mode } = await api.get<{ mode: 'open' | 'locked' }>('/settings/enrollment-mode');
      setEnrollmentMode(mode);
    } catch {
      // non-admin may not see this
    }
  }

  async function handleEnrollmentModeChange(mode: 'open' | 'locked') {
    if (mode === 'open') {
      const ok = await modal.confirm({
        title: 'Open Enrollment',
        message: 'In open mode, any device can enroll without a token. Only use this in trusted networks. Continue?',
        okText: 'Enable Open Mode',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.post('/settings/enrollment-mode', { mode });
      setEnrollmentMode(mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update mode');
    }
  }

  async function loadTokens() {
    try {
      const { tokens: list } = await api.get<{ tokens: TokenInfo[] }>('/enrollment/tokens');
      setTokens(list);
    } catch {
      // non-admin may not see tokens
    }
  }

  async function createToken() {
    setError('');
    setLoading(true);
    try {
      const result = await api.post<{ token: string; label: string; expiresAt: string }>('/enrollment/tokens', {
        label: label || undefined,
        expiresInHours: hours,
      });
      setNewToken(result.token);
      setLabel('');
      await loadTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>Settings</h2>

      {/* Enrollment Mode */}
      {user?.role === 'admin' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h3 className="card-title">Enrollment Mode</h3>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
            Control how devices enroll. <strong>Locked</strong> requires a one-time token.{' '}
            <strong>Open</strong> allows any device to enroll without a token.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn btn-sm ${enrollmentMode === 'locked' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleEnrollmentModeChange('locked')}
            >
              Locked (Token Required)
            </button>
            <button
              className={`btn btn-sm ${enrollmentMode === 'open' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleEnrollmentModeChange('open')}
            >
              Open (No Token)
            </button>
          </div>
          {enrollmentMode === 'open' && (
            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--warning)' }}>
              ⚠ Open mode is active. Any device knowing the server URL can enroll without authorization.
            </p>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3 className="card-title">Enrollment Tokens</h3>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {user?.role !== 'admin' ? 'Admin access required' : ''}
          </span>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
          Create a one-time token to enroll a new agent device. The agent will use this token to register
          with the server and receive its device credentials.
        </p>

        {error && <div className="error-msg">{error}</div>}

        {user?.role === 'admin' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Token label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={{ flex: '1 1 200px' }}
            />
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: 120 }}>
              <option value={1}>1 hour</option>
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
            </select>
            <button className="btn btn-primary" onClick={() => void createToken()} disabled={loading}>
              {loading ? 'Creating…' : 'Create Token'}
            </button>
          </div>
        )}

        {newToken && (
          <div
            style={{
              background: 'rgba(63, 185, 80, 0.1)',
              border: '1px solid var(--success)',
              borderRadius: 'var(--radius-sm)',
              padding: 16,
              marginBottom: 16,
            }}
          >
            <p style={{ fontWeight: 600, marginBottom: 8, color: 'var(--success)' }}>
              Token created — copy it now, it won't be shown again:
            </p>
            <code
              style={{
                display: 'block',
                background: 'var(--bg-tertiary)',
                padding: 12,
                borderRadius: 'var(--radius-sm)',
                wordBreak: 'break-all',
                fontSize: 13,
              }}
            >
              {newToken}
            </code>
            <button
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                void navigator.clipboard.writeText(newToken);
              }}
            >
              Copy to Clipboard
            </button>
          </div>
        )}

        {tokens.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Label</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t, i) => (
                <tr key={i}>
                  <td><code style={{ fontSize: 12 }}>{t.token}</code></td>
                  <td>{t.label}</td>
                  <td style={{ fontSize: 13 }}>{new Date(t.expiresAt).toLocaleString()}</td>
                  <td>
                    <span
                      style={{
                        color: t.used ? 'var(--text-muted)' : 'var(--success)',
                        fontSize: 13,
                      }}
                    >
                      {t.used ? 'Used' : 'Active'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Agent Updates */}
      <AgentUpdatesSection />
    </div>
  );
}

function AgentUpdatesSection() {
  const modal = useModal();
  const [files, setFiles] = useState<{ name: string; size: number; modifiedAt: string }[]>([]);
  const [manifest, setManifest] = useState<{ version: string; filename: string; notes: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ manifest: { version: string; filename: string; notes: string } | null; files: { name: string; size: number; modifiedAt: string }[] }>('/agent/updates');
      setManifest(data.manifest);
      setFiles(data.files);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleUpload() {
    if (!uploadFile || !uploadVersion) {
      setUploadError('File and version are required');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('version', uploadVersion);
      formData.append('notes', uploadNotes);
      await api.post('/agent/updates', formData);
      await load();
      setUploadFile(null);
      setUploadVersion('');
      setUploadNotes('');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteFile(name: string) {
    const ok = await modal.confirm({
      title: 'Delete Update File',
      message: `Delete "${name}"?`,
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/agent/updates/${name}`);
      await load();
    } catch (err) {
      await modal.alert({ title: 'Error', message: 'Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error') });
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 className="card-title">Agent Updates</h3>
        {manifest && manifest.filename && (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Current: v{manifest.version} ({manifest.filename})
          </span>
        )}
      </div>

      {/* Upload form */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>File</label>
          <input
            type="file"
            accept=".exe,.AppImage,.dmg,.msi,.zip"
            onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13 }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, width: 120 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Version</label>
          <input
            type="text"
            placeholder="0.2.0"
            value={uploadVersion}
            onChange={(e) => setUploadVersion(e.target.value)}
            style={{ fontSize: 13, width: '100%' }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Notes</label>
          <input
            type="text"
            placeholder="Release notes (optional)"
            value={uploadNotes}
            onChange={(e) => setUploadNotes(e.target.value)}
            style={{ fontSize: 13, width: '100%' }}
          />
        </div>
        <button className="btn btn-primary btn-sm" onClick={handleUpload} disabled={uploading || !uploadFile || !uploadVersion}>
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>
      {uploadError && <div className="error-msg" style={{ marginBottom: 8 }}>{uploadError}</div>}

      {/* File list */}
      {files.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>No update files uploaded yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td>{f.name}</td>
                <td>{(f.size / 1024 / 1024).toFixed(1)} MB</td>
                <td>{new Date(f.modifiedAt).toLocaleString()}</td>
                <td>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteFile(f.name)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
