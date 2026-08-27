/**
 * Mounted once inside <App/>: runs state/bootstrap (clock skew, device identity, sync loop) and
 * wires the outbox pending count into AppStatusContext. Renders nothing.
 */
import { useEffect } from 'react';
import { bootstrap, shutdown } from '../state/bootstrap';
import { usePendingOps } from '../hooks/usePendingOps';

export function AppBootstrap({ offlineOnly = false }: { offlineOnly?: boolean }): null {
  usePendingOps();
  useEffect(() => {
    void bootstrap({ offlineOnly });
    return () => shutdown();
  }, [offlineOnly]);
  return null;
}

export default AppBootstrap;
