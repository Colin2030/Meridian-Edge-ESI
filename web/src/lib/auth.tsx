import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

export interface LicenceSummary {
  installed: boolean; valid: boolean; expired: boolean;
  customer: string | null; seats: number | null; seatsUsed: number; seatsRemaining: number | null;
  expiresAt: string | null; daysRemaining: number | null; reason?: string;
}
export interface User { id: number; username: string; displayName: string; email?: string; isSystemAdmin: boolean; canCreateCases?: boolean; licence?: LicenceSummary; }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<User>('/api/auth/me').then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const u = await api.post<User>('/api/auth/login', { username, password });
    setUser(u);
  };
  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  };
  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
