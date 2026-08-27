/**
 * Captures Chrome's `beforeinstallprompt` so Settings can offer an "Install app" button.
 * The event fires early (before the lazy Settings chunk loads), so capture is registered from
 * <AlertHost/>, which App.tsx mounts on every route.
 */
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface InstallState {
  /** A deferred prompt is available (Chrome / Edge / Samsung Internet, not yet installed). */
  canPrompt: boolean;
  /** Running in standalone mode (already installed). */
  installed: boolean;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: isStandalone() };
let registered = false;
const listeners = new Set<() => void>();

function emit(next: InstallState): void {
  state = next;
  listeners.forEach((cb) => cb());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): InstallState {
  return state;
}

/** Idempotent; returns a cleanup that only removes listeners on the last registration. */
export function captureInstallPrompt(): () => void {
  if (registered || typeof window === 'undefined') return () => undefined;
  registered = true;
  const onPrompt = (e: Event) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit({ ...state, canPrompt: true });
  };
  const onInstalled = () => {
    deferred = null;
    emit({ canPrompt: false, installed: true });
  };
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
    registered = false;
  };
}

/** Show the native install dialog; resolves to the user's choice ("unavailable" when no prompt). */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = deferred;
  if (!evt) return 'unavailable';
  try {
    await evt.prompt();
    const choice = await evt.userChoice;
    if (choice.outcome === 'accepted') deferred = null;
    emit({ ...state, canPrompt: deferred !== null });
    return choice.outcome;
  } catch {
    return 'unavailable';
  }
}

export function useInstallPrompt(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
