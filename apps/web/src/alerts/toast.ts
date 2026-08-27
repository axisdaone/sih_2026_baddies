/**
 * In-app toast store (module-level, like UpdateToast) so non-React code — checkAlerts(), the sync
 * loop, Settings actions — can notify the user. <AlertHost/> (mounted once in App.tsx) renders it.
 */
import { useSyncExternalStore } from 'react';

export type ToastKind = 'alert' | 'critical' | 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Optional in-app route to open when tapped (e.g. /batch/:id). */
  to?: string;
  /** Show the SIMULATED chip on the toast. */
  simulated?: boolean;
  /** Auto-dismiss after this many ms (default 8 s; 0 = sticky). */
  ttlMs?: number;
  createdAt: number;
}

const MAX_VISIBLE = 4;
const DEFAULT_TTL_MS = 8_000;

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function emit(next: Toast[]): void {
  toasts = next;
  listeners.forEach((cb) => cb());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Toast[] {
  return toasts;
}

export function pushToast(input: Omit<Toast, 'id' | 'createdAt'> & { id?: string }): string {
  counter += 1;
  const id = input.id ?? `toast-${Date.now()}-${counter}`;
  const toast: Toast = { ...input, id, createdAt: Date.now() };
  // Replace a toast with the same id (e.g. re-fired alert) instead of stacking duplicates.
  const rest = toasts.filter((t) => t.id !== id);
  emit([...rest, toast].slice(-MAX_VISIBLE));
  const ttl = toast.ttlMs ?? DEFAULT_TTL_MS;
  if (ttl > 0 && typeof setTimeout === 'function') setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id: string): void {
  if (!toasts.some((t) => t.id === id)) return;
  emit(toasts.filter((t) => t.id !== id));
}

export function clearToasts(): void {
  emit([]);
}

/** Convenience wrappers. */
export const notify = {
  info: (title: string, body?: string, extra: Partial<Toast> = {}) => pushToast({ kind: 'info', title, body, ...extra }),
  success: (title: string, body?: string, extra: Partial<Toast> = {}) => pushToast({ kind: 'success', title, body, ...extra }),
  error: (title: string, body?: string, extra: Partial<Toast> = {}) => pushToast({ kind: 'error', title, body, ...extra }),
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
