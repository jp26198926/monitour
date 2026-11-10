import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { DeviceInfo } from '@monitour/shared';

export function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api
      .get<DeviceInfo>(`/devices/${id}`)
      .then(setDevice)
      .catch((err) => console.error('Failed to load device:', err))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;
  if (!device) return <p style={{ color: 'var(--danger)' }}>Device not found</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <button className="btn btn-secondary" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h2 style={{ fontSize: 22, fontWeight: 600 }}>{device.name}</h2>
        <span className={`status-dot ${device.status}`} />
        <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{device.status}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* System Info */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>System Information</h3>
          <table className="data-table">
            <tbody>
              <tr><td style={{ color: 'var(--text-muted)' }}>Hostname</td><td>{device.hostname}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Platform</td><td>{device.platform}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Architecture</td><td>{device.arch}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Agent Version</td><td>{device.agentVersion}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Last Seen</td><td>{device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'Never'}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Enrolled</td><td>{new Date(device.enrolledAt).toLocaleString()}</td></tr>
              {device.systemInfo && (
                <>
                  <tr><td style={{ color: 'var(--text-muted)' }}>CPU Cores</td><td>{device.systemInfo.cpus}</td></tr>
                  <tr><td style={{ color: 'var(--text-muted)' }}>Memory</td><td>{device.systemInfo.freeMemMB} MB free / {device.systemInfo.totalMemMB} MB</td></tr>
                  <tr><td style={{ color: 'var(--text-muted)' }}>Uptime</td><td>{Math.floor(device.systemInfo.uptimeSec / 3600)}h {Math.floor((device.systemInfo.uptimeSec % 3600) / 60)}m</td></tr>
                  <tr><td style={{ color: 'var(--text-muted)' }}>OS Version</td><td>{device.systemInfo.osVersion}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Actions */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Actions</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              className="btn btn-primary"
              onClick={() => navigate(`/devices/${device.id}/desktop`)}
              disabled={device.status !== 'online'}
            >
              Remote Desktop
            </button>
            <button
              className="btn btn-secondary"
              disabled={device.status !== 'online'}
              title="Coming soon"
            >
              Terminal
            </button>
            <button
              className="btn btn-secondary"
              disabled={device.status !== 'online'}
              title="Coming soon"
            >
              File Manager
            </button>
          </div>

          {device.status !== 'online' && (
            <p style={{ marginTop: 16, color: 'var(--text-muted)', fontSize: 13 }}>
              Agent is offline. Actions are available when the device is connected.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
