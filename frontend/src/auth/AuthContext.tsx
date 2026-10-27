import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Ré-interroge `/me` : le front ne déduit jamais l'identité de son stockage (PRD §5.4). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh();
    // Session glissante de 8 h : on revérifie périodiquement et au retour sur l'onglet.
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const t = window.setInterval(refresh, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(t);
    };
  }, [refresh]);

  return <Ctx.Provider value={{ user, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth hors AuthProvider');
  return v;
}
