/** Keeps AppStatusContext.pendingOps in step with the outbox (subscribePending). */
import { useEffect } from 'react';
import { subscribePending } from '../sync';
import { useAppStatus } from '../state/appStatus';

export function usePendingOps(): number {
  const { pendingOps, setPendingOps } = useAppStatus();
  useEffect(() => subscribePending(setPendingOps), [setPendingOps]);
  return pendingOps;
}
