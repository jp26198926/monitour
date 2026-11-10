import { useEffect, useState, useCallback, useMemo, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDeviceStore, useAuthStore } from '../store';
import { useModal } from '../components/Modal';
import { api } from '../api/client';
import { io, type Socket } from 'socket.io-client';
import type { DeviceInfo, GroupInfo } from '@monitour/shared';

type ViewMode = 'table' | 'grid';

interface ThumbnailEntry {
  data: string;
  ts: number;
}

export function DevicesPage() {
  const navigate = useNavigate();
  const { devices, setDevices, updateDeviceStatus } = useDeviceStore();
  const { token } = useAuthStore();
  const modal = useModal();
  const [loading, setLoading] = useState(true);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem('monitour_viewMode') as ViewMode) || 'table',
  );
  const [thumbnails, setThumbnails] = useState<Record<string, ThumbnailEntry>>({});

  // Search & filter state
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [groups, setGroups] = useState<GroupInfo[]>([]);

  // Edit modal state
  const [editDevice, setEditDevice] = useState<DeviceInfo | null>(null);
  const [editAlias, setEditAlias] = useState('');
  const [editGroup, setEditGroup] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const handleThumbnailUpdate = useCallback(
    (payload: { deviceId: string; data: string; width: number; height: number; ts: number }) => {
      setThumbnails((prev) => ({ ...prev, [payload.deviceId]: { data: payload.data, ts: payload.ts } }));
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let s: Socket | null = null;

    async function init() {
      try {
        const [{ devices: list }, { groups: groupList }] = await Promise.all([
          api.get<{ devices: DeviceInfo[] }>('/devices'),
          api.get<{ groups: GroupInfo[] }>('/groups'),
        ]);
        if (!cancelled) {
          setDevices(list);
          setGroups(groupList);
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to fetch devices:', err);
        if (!cancelled) setLoading(false);
      }

      if (token && !cancelled) {
        s = io('/dashboard', { auth: { token } });
        s.on('dash:devices-update', (payload: { devices: DeviceInfo[] }) => {
          if (!cancelled) setDevices(payload.devices);
        });
        s.on('device:status-update', (payload: { deviceId: string; status: string; systemInfo?: unknown }) => {
          if (!cancelled) updateDeviceStatus(payload.deviceId, payload.status, payload.systemInfo);
        });
        s.on('device:thumbnail-update', (payload: { deviceId: string; data: string; width: number; height: number; ts: number }) => {
          if (!cancelled) handleThumbnailUpdate(payload);
        });
        s.on('dash:thumbnails', (payload: Record<string, ThumbnailEntry>) => {
          if (!cancelled) setThumbnails(payload);
        });
        s.emit('dash:request-devices');
        s.emit('dash:request-thumbnails');
        setSocket(s);
      }
    }

    void init();

    return () => {
      cancelled = true;
      s?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filtered devices
  const filtered = useMemo(() => {
    let list = devices;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.hostname.toLowerCase().includes(q) ||
          (d.alias && d.alias.toLowerCase().includes(q)),
      );
    }
    if (groupFilter !== 'all') {
      if (groupFilter === '__none__') {
        list = list.filter((d) => !d.group);
      } else {
        list = list.filter((d) => d.group === groupFilter);
      }
    }
    if (statusFilter !== 'all') {
      list = list.filter((d) => d.status === statusFilter);
    }
    return list;
  }, [devices, search, groupFilter, statusFilter]);

  function toggleView(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem('monitour_viewMode', mode);
  }

  function openEdit(d: DeviceInfo) {
    setEditDevice(d);
    setEditAlias(d.alias || '');
    setEditGroup(d.group || null);
    setEditError('');
  }

  async function handleEditSave(e: FormEvent) {
    e.preventDefault();
    if (!editDevice) return;
    setEditSaving(true);
    setEditError('');
    try {
      await api.patch(`/devices/${editDevice.id}`, {
        alias: editAlias,
        group: editGroup,
      });
      // Update local state
      setDevices(devices.map((d) => (d.id === editDevice.id ? { ...d, alias: editAlias, group: editGroup } : d)));
      setEditDevice(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete(id: string) {
    const ok = await modal.confirm({
      title: 'Delete Device',
      message: 'Delete this device? This action cannot be undone.',
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/devices/${id}`);
      setDevices(devices.filter((d) => d.id !== id));
    } catch (err) {
      await modal.alert({
        title: 'Error',
        message: 'Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error'),
      });
    }
  }

  const displayName = (d: DeviceInfo) => d.alias || d.name;

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Devices</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="view-toggle">
              <button className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`} onClick={() => toggleView('table')} title="Table view">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="14" height="2" rx="0.5" /><rect x="1" y="7" width="14" height="2" rx="0.5" /><rect x="1" y="11" width="14" height="2" rx="0.5" /></svg>
              </button>
              <button className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`} onClick={() => toggleView('grid')} title="Grid view">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" /><rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg>
              </button>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => socket?.emit('dash:request-devices')}>Refresh</button>
          </div>
        </div>

        {/* Search & Filter bar */}
        <div className="filter-bar">
          <input
            className="search-input"
            type="text"
            placeholder="Search by name, hostname, or alias..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="filter-select" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="all">All Groups</option>
            <option value="__none__">No Group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.name}>{g.name}</option>
            ))}
          </select>
          <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="pending">Pending</option>
            <option value="error">Error</option>
          </select>
          {(search || groupFilter !== 'all' || statusFilter !== 'all') && (
            <button className="btn btn-secondary btn-sm" onClick={() => { setSearch(''); setGroupFilter('all'); setStatusFilter('all'); }}>
              Clear
            </button>
          )}
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading devices...</p>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: 16, marginBottom: 8 }}>
              {devices.length === 0 ? 'No devices enrolled yet' : 'No devices match your filters'}
            </p>
            {devices.length === 0 && (
              <p style={{ fontSize: 13 }}>
                Go to <strong>Settings</strong> to create an enrollment token, then run the agent on a device.
              </p>
            )}
          </div>
        ) : viewMode === 'table' ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Group</th>
                <th>Hostname</th>
                <th>Platform</th>
                <th>Last Seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/devices/${d.id}`)}>
                  <td>
                    <span className={`status-dot ${d.status}`} />
                    {d.status}
                  </td>
                  <td style={{ fontWeight: 500 }}>{displayName(d)}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{d.group || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{d.hostname}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{d.platform}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'Never'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={d.status !== 'online'}
                        style={d.status !== 'online' ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                        onClick={() => navigate(`/devices/${d.id}/desktop`)}
                      >
                        Connect
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(d)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleDelete(d.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="device-grid">
            {filtered.map((d) => {
              const thumb = thumbnails[d.id];
              return (
                <div key={d.id} className={`device-card ${d.status === 'online' ? 'online' : ''}`} onClick={() => navigate(`/devices/${d.id}`)}>
                  <div className="device-card-thumbnail">
                    {thumb ? (
                      <img src={`data:image/jpeg;base64,${thumb.data}`} alt={displayName(d)} />
                    ) : (
                      <div className="thumbnail-placeholder">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
                        <span>{d.status === 'online' ? 'Waiting for preview...' : 'No preview'}</span>
                      </div>
                    )}
                    <div className="device-card-status">
                      <span className={`status-dot ${d.status}`} />
                    </div>
                  </div>
                  <div className="device-card-info">
                    <div className="device-card-name">{displayName(d)}</div>
                    <div className="device-card-meta">
                      <span>{d.group || d.hostname || d.platform}</span>
                      <span className="device-card-time">{d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : ''}</span>
                    </div>
                  </div>
                  <div className="device-card-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={d.status !== 'online'}
                      style={d.status !== 'online' ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                      onClick={() => navigate(`/devices/${d.id}/desktop`)}
                    >
                      Connect
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(d)}>Edit</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d.id)}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Device Modal */}
      {editDevice && (
        <div className="modal-backdrop" onClick={() => setEditDevice(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Device</h3>
              <button className="modal-close" onClick={() => setEditDevice(null)}>&times;</button>
            </div>
            <form onSubmit={handleEditSave}>
              <div className="modal-body">
                {editError && <div className="error-msg">{editError}</div>}
                <div className="form-group">
                  <label>Device Name</label>
                  <input type="text" value={editDevice.name} disabled />
                </div>
                <div className="form-group">
                  <label>Alias</label>
                  <input
                    type="text"
                    value={editAlias}
                    onChange={(e) => setEditAlias(e.target.value)}
                    placeholder="Custom display name"
                    maxLength={64}
                  />
                </div>
                <div className="form-group">
                  <label>Group</label>
                  <select value={editGroup ?? '__none__'} onChange={(e) => setEditGroup(e.target.value === '__none__' ? null : e.target.value)}>
                    <option value="__none__">No Group</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setEditDevice(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={editSaving}>
                  {editSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
