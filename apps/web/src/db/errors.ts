/**
 * Classify storage failures so the UI can explain them (contract §9: user-facing strings go through
 * i18n, never Dexie's raw English messages). Dexie surfaces "IndexedDB absent" as `MissingAPIError`
 * (not only `OpenFailedError`), quota problems as `QuotaExceededError`, and a database closed by
 * another tab as `DatabaseClosedError` / `VersionError`.
 */
export const STORAGE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'MissingAPIError',
  'OpenFailedError',
  'UnknownError',
  'QuotaExceededError',
  'DatabaseClosedError',
  'InvalidStateError',
  'VersionError',
]);

/** True when `err` means local storage (IndexedDB) is unavailable, blocked, full or closed. */
export function isStorageError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (STORAGE_ERROR_NAMES.has(err.name)) return true;
  // Dexie wraps the original DOMException as `inner`; classify by that too.
  const inner = (err as Error & { inner?: unknown }).inner;
  return inner instanceof Error && STORAGE_ERROR_NAMES.has(inner.name);
}
