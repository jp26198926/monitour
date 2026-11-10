import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store';
import { ModalProvider } from './components/Modal';
import { LoginPage } from './pages/Login';
import { DashboardLayout } from './components/DashboardLayout';
import { DevicesPage } from './pages/Devices';
import { DeviceDetailPage } from './pages/DeviceDetail';
import { RemoteDesktopPage } from './pages/RemoteDesktop';
import { SettingsPage } from './pages/Settings';
import { GroupsPage } from './pages/Groups';

export default function App() {
  const { token, user, restore } = useAuthStore();

  useEffect(() => {
    restore();
  }, [restore]);

  return (
    <ModalProvider>
      {!token || !user ? (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<DevicesPage />} />
            <Route path="/devices/:id" element={<DeviceDetailPage />} />
            <Route path="/devices/:id/desktop" element={<RemoteDesktopPage />} />
            <Route path="/groups" element={<GroupsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </ModalProvider>
  );
}
