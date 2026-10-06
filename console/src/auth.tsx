import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, post } from './api';

export interface Me { id: string; email: string; name: string; role: 'OWNER' | 'ADMIN' | 'FINANCE' | 'SUPPORT'; roleName: string; can: string[] }
interface AuthState { loading: boolean; setupNeeded: boolean; me: Me | null; refresh: () => Promise<void>; signOut: () => Promise<void>; can: (a: string) => boolean }

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ loading: true, setupNeeded: false, me: null as Me | null });
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ setupNeeded: boolean; me: Me | null }>('/auth/state');
      setState({ loading: false, setupNeeded: s.setupNeeded, me: s.me });
    } catch {
      setState((x) => ({ ...x, loading: false }));
    }
  }, []);
  const signOut = useCallback(async () => {
    await post('/auth/logout').catch(() => {});
    setState((x) => ({ ...x, me: null }));
  }, []);
  useEffect(() => {
    refresh();
    const onOut = () => setState((x) => ({ ...x, me: null }));
    window.addEventListener('hoolam:signed-out', onOut);
    return () => window.removeEventListener('hoolam:signed-out', onOut);
  }, [refresh]);
  const can = useCallback((a: string) => !!state.me?.can.includes(a), [state.me]);
  return <Ctx.Provider value={{ ...state, refresh, signOut, can }}>{children}</Ctx.Provider>;
}
