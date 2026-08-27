/**
 * One-time app bootstrap (run from <AppBootstrap/>): load the persisted clock skew, make sure the
 * device has an id (and a token when online), then start the sync loop. Everything is best-effort
 * and non-blocking — the UI renders from Dexie regardless.
 */
import { ensureDevice } from '../api/auth';
import { loadClockSkew, startSyncLoop } from '../sync';

let started = false;
let stopLoop: (() => void) | null = null;

export interface BootstrapOptions {
  /** Skip the network side (tests). */
  offlineOnly?: boolean;
}

/** Idempotent: the second call returns the existing stop function. */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<() => void> {
  if (started && stopLoop) return stopLoop;
  started = true;
  await loadClockSkew();
  if (!opts.offlineOnly) {
    void ensureDevice();
    stopLoop = startSyncLoop();
  } else {
    stopLoop = () => undefined;
  }
  return stopLoop;
}

/** Stop the sync loop and allow bootstrap() to run again (hot reload / tests). */
export function shutdown(): void {
  stopLoop?.();
  stopLoop = null;
  started = false;
}
