/** Device / sync diagnostics from Dexie meta + AppStatusContext. */
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, META_KEYS } from '../../db';
import { useFormat } from '../../i18n/useFormat';
import { useAppStatus } from '../../state/appStatus';

export const APP_VERSION: string = String(import.meta.env.VITE_APP_VERSION ?? '0.1.0');

export function DeviceInfo(): JSX.Element {
  const { t } = useTranslation('settings');
  const f = useFormat();
  const { online, pendingOps } = useAppStatus();
  const meta = useLiveQuery(async () => {
    const [deviceId, displayName, share, lastSync, skew] = await Promise.all([
      db.getMeta<string>(META_KEYS.deviceId),
      db.getMeta<string>(META_KEYS.displayName),
      db.getMeta<boolean>(META_KEYS.shareDisplayName),
      db.getMeta<string>(META_KEYS.lastSyncAt),
      db.getMeta<number>(META_KEYS.clockSkewSeconds),
    ]);
    // A name the farmer opted out of sharing (or cleared) is not shown as "the farmer".
    const shownName = share === false || !displayName?.trim() ? null : displayName.trim();
    return { deviceId, displayName: shownName, lastSync, skew };
  }, []);

  const rows: Array<[string, string]> = [
    [t('device.device_id'), meta?.deviceId ? meta.deviceId.slice(0, 12) : t('device.unknown')],
    [t('device.farmer'), meta?.displayName ?? t('device.unknown')],
    [t('device.last_sync'), meta?.lastSync ? f.dateTime(meta.lastSync) : t('device.never')],
    [t('device.pending'), f.number(pendingOps)],
    [t('device.skew'), typeof meta?.skew === 'number' ? t('device.skew_value', { seconds: f.number(meta.skew, { maximumFractionDigits: 0 }) }) : t('device.unknown')],
    [t('device.version'), `${APP_VERSION} (${import.meta.env.MODE})`],
  ];

  return (
    <section className="card" aria-label={t('device.title')}>
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('device.title')}</h2>
        <span className={`chip ${online ? 'bg-brand-100 text-brand-900' : 'bg-amber-100 text-amber-900'}`}>{online ? t('device.online') : t('device.offline')}</span>
      </header>
      <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-600">{k}</dt>
            <dd className="break-all font-medium tabular">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default DeviceInfo;
