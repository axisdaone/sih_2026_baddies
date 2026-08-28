/**
 * AppStatusContext — tiny, dependency-free global status: connectivity + outbox pending count.
 * Feature agents: call `setPendingOps(n)` from sync/ after each enqueue/drain; read with `useAppStatus()`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface AppStatus {
  /** navigator.onLine, kept live via online/offline events. */
  online: boolean;
  /** Number of outbox ops not yet acknowledged by the server. */
  pendingOps: number;
  setPendingOps: (n: number) => void;
}

const AppStatusContext = createContext<AppStatus | null>(null);

function readOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine;
}

export function AppStatusProvider({ children }: { children: ReactNode }): JSX.Element {
  const [online, setOnline] = useState<boolean>(readOnline);
  const [pendingOps, setPendingOpsState] = useState<number>(0);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const setPendingOps = useCallback((n: number) => setPendingOpsState(Math.max(0, Math.floor(n))), []);

  const value = useMemo<AppStatus>(() => ({ online, pendingOps, setPendingOps }), [online, pendingOps, setPendingOps]);
  return <AppStatusContext.Provider value={value}>{children}</AppStatusContext.Provider>;
}

export function useAppStatus(): AppStatus {
  const ctx = useContext(AppStatusContext);
  if (!ctx) throw new Error('useAppStatus must be used inside <AppStatusProvider>');
  return ctx;
}
