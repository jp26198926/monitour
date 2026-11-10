import { create } from 'zustand';
import { api } from '../api/client';
import type { DeviceInfo, UserInfo } from '@monitour/shared';

interface AuthState {
  user: UserInfo | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
  restore: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: localStorage.getItem('monitour_token'),

  login: async (username, password) => {
    const { token, user } = await api.post<{ token: string; user: UserInfo }>('/auth/login', {
      username,
      password,
    });
    localStorage.setItem('monitour_token', token);
    localStorage.setItem('monitour_user', JSON.stringify(user));
    set({ token, user });
  },

  register: async (username, password, displayName) => {
    const { token, user } = await api.post<{ token: string; user: UserInfo }>('/auth/register', {
      username,
      password,
      displayName,
    });
    localStorage.setItem('monitour_token', token);
    localStorage.setItem('monitour_user', JSON.stringify(user));
    set({ token, user });
  },

  logout: () => {
    localStorage.removeItem('monitour_token');
    localStorage.removeItem('monitour_user');
    set({ token: null, user: null });
  },

  restore: () => {
    const token = localStorage.getItem('monitour_token');
    const userJson = localStorage.getItem('monitour_user');
    if (token && userJson) {
      try {
        set({ token, user: JSON.parse(userJson) as UserInfo });
      } catch {
        set({ token: null, user: null });
      }
    }
  },
}));

interface DeviceState {
  devices: DeviceInfo[];
  selectedDevice: DeviceInfo | null;
  setDevices: (devices: DeviceInfo[]) => void;
  updateDeviceStatus: (deviceId: string, status: string, systemInfo?: unknown) => void;
  setSelectedDevice: (device: DeviceInfo | null) => void;
}

export const useDeviceStore = create<DeviceState>((set) => ({
  devices: [],
  selectedDevice: null,

  setDevices: (devices) => set({ devices }),

  updateDeviceStatus: (deviceId, status, systemInfo) =>
    set((state) => ({
      devices: state.devices.map((d) =>
        d.id === deviceId
          ? {
              ...d,
              status: status as DeviceInfo['status'],
              lastSeen: new Date().toISOString(),
              systemInfo: (systemInfo as DeviceInfo['systemInfo']) ?? d.systemInfo,
            }
          : d,
      ),
    })),

  setSelectedDevice: (device) => set({ selectedDevice: device }),
}));
