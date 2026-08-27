import { useTranslation } from 'react-i18next';
import { useAppStatus } from '../state/appStatus';

/** Small dot + label reflecting navigator.onLine (via AppStatusContext). */
export function OfflineIndicator({ className = '' }: { className?: string }): JSX.Element {
  const { t } = useTranslation('common');
  const { online } = useAppStatus();
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
        online ? 'bg-brand-100 text-brand-900' : 'bg-amber-100 text-amber-900'
      } ${className}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${online ? 'bg-brand-600' : 'bg-amber-500'}`} />
      {online ? t('online') : t('offline')}
    </span>
  );
}

export default OfflineIndicator;
