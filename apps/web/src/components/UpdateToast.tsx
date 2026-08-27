/**
 * "Update available" toast driven by registerSW() in main.tsx (outside React), so state lives in a
 * tiny module-level store and <UpdateToastHost/> subscribes to it.
 */
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import Button from './Button';

interface ToastState {
  visible: boolean;
  onAccept: (() => void) | null;
}

let state: ToastState = { visible: false, onAccept: null };
const listeners = new Set<() => void>();

function emit(next: ToastState): void {
  state = next;
  listeners.forEach((cb) => cb());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): ToastState {
  return state;
}

/** Show the toast; `onAccept` should call the SW update function. */
export function showUpdateToast(onAccept: () => void): void {
  emit({ visible: true, onAccept });
}

export function hideUpdateToast(): void {
  emit({ visible: false, onAccept: null });
}

export function UpdateToastHost(): JSX.Element | null {
  const { t } = useTranslation('common');
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!snap.visible) return null;
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={t('update_available')}
      className="fixed inset-x-3 z-50 flex items-center justify-between gap-3 rounded-2xl bg-gray-900 px-4 py-3 text-white shadow-lg"
      style={{ bottom: 'calc(var(--fs-nav-h) + var(--fs-safe-bottom) + 0.75rem)' }}
    >
      <span className="text-sm font-medium">{t('update_available')}</span>
      <div className="flex shrink-0 gap-2">
        <Button variant="secondary" className="!min-h-10 !px-3 !text-sm" onClick={hideUpdateToast}>
          {t('cancel')}
        </Button>
        <Button
          className="!min-h-10 !px-3 !text-sm"
          onClick={() => {
            snap.onAccept?.();
            hideUpdateToast();
          }}
        >
          {t('update_now')}
        </Button>
      </div>
    </div>
  );
}

export default UpdateToastHost;
