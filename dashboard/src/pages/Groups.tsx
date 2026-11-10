import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useModal } from '../components/Modal';
import type { GroupInfo } from '@monitour/shared';

export function GroupsPage() {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const modal = useModal();

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    try {
      const { groups: list } = await api.get<{ groups: GroupInfo[] }>('/groups');
      setGroups(list);
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (editId) {
        await api.patch(`/groups/${editId}`, { name, description });
      } else {
        await api.post('/groups', { name, description });
      }
      setShowForm(false);
      setEditId(null);
      setName('');
      setDescription('');
      await loadGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save group');
    }
  }

  async function handleDelete(id: string) {
    const ok = await modal.confirm({
      title: 'Delete Group',
      message: 'Delete this group? Devices in it will become ungrouped.',
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/groups/${id}`);
      await loadGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  }

  function startEdit(g: GroupInfo) {
    setEditId(g.id);
    setName(g.name);
    setDescription(g.description);
    setShowForm(true);
    setError('');
  }

  function startCreate() {
    setEditId(null);
    setName('');
    setDescription('');
    setShowForm(true);
    setError('');
  }

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Groups</h2>
          <button className="btn btn-primary btn-sm" onClick={startCreate}>
            + Create Group
          </button>
        </div>

        {error && <div className="error-msg">{error}</div>}

        {showForm && (
          <form onSubmit={handleSubmit} style={{ marginBottom: 20, padding: 16, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: '1 1 200px', marginBottom: 0 }}>
                <label>Group Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} autoFocus />
              </div>
              <div className="form-group" style={{ flex: '2 1 300px', marginBottom: 0 }}>
                <label>Description</label>
                <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary btn-sm">{editId ? 'Save' : 'Create'}</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setShowForm(false); setEditId(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          </form>
        )}

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading groups...</p>
        ) : groups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: 16, marginBottom: 8 }}>No groups yet</p>
            <p style={{ fontSize: 13 }}>Create a group to organize your devices.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Devices</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td style={{ fontWeight: 500 }}>{g.name}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{g.description || '—'}</td>
                  <td>{g.deviceCount}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>{new Date(g.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(g)}>Edit</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(g.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
