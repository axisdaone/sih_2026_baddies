/**
 * Renders the toast stack (threshold alerts + generic notices) above the bottom nav.
 * Mounted once in App.tsx next to <UpdateToastHost/>; it is the earliest component we own, which is
 * why the PWA install-prompt capture is wired from here as well.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SimBadge } from '../components/SimBadge';
import { captureInstallPrompt } from '../components/settings/installPrompt';
import { dismissToast, useToasts, type ToastKind } from './toast';

const KIND_CLASS: Record<ToastKind, string> = {
  alert: 'border-warning bg-amber-50 text-amber-950',
  critical: 'border-critical bg-orange-50 text-orange-950',
  info: 'border-gray-300 bg-white text-gray-900',
  success: 'border-brand-600 bg-brand-50 text-brand-900',
  error: 'border-spoiled bg-red-50 text-red-900',
};

export function AlertHost(): JSX.Element | null {
  const { t } = useTranslation('alerts');
  const toasts = useToasts();
  const navigate = useNavigate();

  useEffect(() => captureInstallPrompt(), []);

  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-3 z-50 flex flex-col gap-2"
      style={{ bottom: 'calc(var(--fs-nav-h) + var(--fs-safe-bottom) + 0.75rem)' }}
      aria-live="assertive"
      role="region"
      aria-label={t('region_label')}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'alert' || toast.kind === 'critical' ? 'alert' : 'status'}
          data-testid={`toast-${toast.kind}`}
          className={`pointer-events-auto flex items-start gap-3 rounded-2xl border-2 px-4 py-3 shadow-lg ${KIND_CLASS[toast.kind]}`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-bold leading-tight">{toast.title}</p>
              {toast.simulated && <SimBadge />}
            </div>
            {toast.body && <p className="mt-1 text-sm leading-snug">{toast.body}</p>}
            {toast.to && (
              <button
                type="button"
                className="mt-2 min-h-10 rounded-lg bg-white/70 px-3 text-sm font-semibold underline-offset-2 hover:underline"
                onClick={() => {
                  dismissToast(toast.id);
                  navigate(toast.to as string);
                }}
              >
                {t('open_batch')}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={t('dismiss')}
            className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl leading-none hover:bg-black/5"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default AlertHost;
