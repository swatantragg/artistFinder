// App-wide state: the backend connection, the signed-in person, a revision counter that refreshes every screen after a
// write, and toasts. Screens read data with useQuery and write with run().
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandResult } from '@domain/commands';
import type { Role } from '@domain/constants';
import type { User } from '@domain/types';
import type { Backend, Me } from '../api/backend';

export interface Meta {
  users: User[];
  me: User | null;
  today: string;
  badges: { queue: number; reopened: number; identity: number; exceptions: number; notifications: number; discovery: number; searching: number; dedupe: number; needsReview: number; reopenedArtists: number; goongoonaloPending: number };
  permissions: Record<string, boolean>;
  /** Why Find artist is off (no live search provider configured, or the usage limit reached), or null. */
  discoveryBlocked: string | null;
}
export interface Toast { id: number; text: string; tone: 'ok' | 'error' | 'info' }

interface AppState {
  backend: Backend;
  /** The signed-in person (from the session cookie; the server decides who is asking). */
  me: Me;
  userId: string;
  signOut(): void;
  meta: Meta | null;
  rev: number;
  refresh(): void;
  run(name: string, params: object, opts?: { quiet?: boolean }): Promise<CommandResult | null>;
  toast(text: string, tone?: Toast['tone']): void;
  toasts: Toast[];
  dismiss(id: number): void;
  can(perm: string): boolean;
  role: Role | null;
}
const Ctx = createContext<AppState | null>(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error('useApp outside provider'); return c; };

export function AppProvider({ backend, me, onSignOut, children }: { backend: Backend; me: Me; onSignOut: () => void; children: ReactNode }) {
  const userId = me.id;
  const [rev, setRev] = useState(0);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current;
    setToasts(t => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), tone === 'error' ? 7000 : 4200);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const refresh = useCallback(() => setRev(r => r + 1), []);
  const signOut = useCallback(() => { void backend.logout().then(onSignOut); }, [backend, onSignOut]);

  useEffect(() => {
    let alive = true;
    backend.query<Meta>('meta', {}).then(m => { if (alive) setMeta(m); }).catch(() => {});
    return () => { alive = false; };
  }, [backend, userId, rev]);

  const run = useCallback(async (name: string, params: object, opts: { quiet?: boolean } = {}) => {
    try {
      const res = await backend.command(name, params);
      if (!opts.quiet) toast(res.message, 'ok');
      setRev(r => r + 1);
      return res;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  }, [backend, toast]);

  const value = useMemo<AppState>(() => ({
    backend, me: meta?.me ? { ...me, ...meta.me } : me, userId, signOut, meta, rev, refresh, run, toast, toasts, dismiss,
    can: (perm: string) => !!meta?.permissions[perm], role: meta?.me?.role ?? me.role,
  }), [backend, me, userId, signOut, meta, rev, refresh, run, toast, toasts, dismiss]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Load a read model; reloads after every write and keeps the previous data while refreshing (no flicker).
 *  `poll` (ms) re-reads quietly in the background, e.g. while a discovery job is running. */
export function useQuery<T>(name: string | null, params: object = {}, opts: { poll?: number | false } = {}) {
  const { backend, rev, userId } = useApp();
  const key = JSON.stringify(params);
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean; key: string }>({ data: undefined, error: null, loading: true, key: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!name || !opts.poll) return;
    const t = setInterval(() => setTick(n => n + 1), opts.poll);
    return () => clearInterval(t);
  }, [name, opts.poll]);
  useEffect(() => {
    if (!name) return;
    let alive = true;
    setState(s => (s.key === name + key ? s : { ...s, loading: true }));
    backend.query<T>(name, JSON.parse(key))
      .then(data => { if (alive) setState({ data, error: null, loading: false, key: name + key }); })
      .catch(e => { if (alive) setState({ data: undefined, error: (e as Error).message, loading: false, key: name + key }); });
    return () => { alive = false; };
  }, [backend, name, key, rev, userId, tick]);
  // Data from a different query (e.g. another case) is not shown while the new one loads.
  const fresh = state.key === (name ?? '') + key;
  return { data: fresh ? state.data : undefined, error: state.error, loading: state.loading || !fresh };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
