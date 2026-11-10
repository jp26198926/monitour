import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store';

export function DashboardLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">Monitour</div>
        <nav className="sidebar-nav">
          <NavLink to="/" end>
            <span>Devices</span>
          </NavLink>
          <NavLink to="/groups">
            <span>Groups</span>
          </NavLink>
          <NavLink to="/settings">
            <span>Settings</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <div style={{ marginBottom: 8 }}>{user?.displayName || user?.username}</div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
