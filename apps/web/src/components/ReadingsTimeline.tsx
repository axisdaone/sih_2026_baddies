/** Thermal history list: temperature, IST time, source chip (manual / SIMULATED / BLE), hash prefix once synced. */
import { useTranslation } from 'react-i18next';
import type { ReadingRow } from '../db';
import { useFormat } from '../i18n/useFormat';
import { shortId } from '../lib/ids';
import { SimBadge } from './SimBadge';

export interface ReadingsTimelineProps {
  readings: ReadingRow[];
  /** Highlight readings at/above this temperature (protocol max_effective / hard threshold hint). */
  hotAboveC?: number;
}

function SourceChip({ source }: { source: ReadingRow['source'] }): JSX.Element {
  const { t } = useTranslation('batch');
  if (source === 'sim') return <SimBadge />;
  if (source === 'ble') return <span className="chip bg-sky-100 text-sky-900">{t('source.ble')}</span>;
  return <span className="chip bg-gray-100 text-gray-800">{t('source.manual')}</span>;
}

export function ReadingsTimeline({ readings, hotAboveC = 40 }: ReadingsTimelineProps): JSX.Element {
  const { t } = useTranslation('batch');
  const f = useFormat();
  if (readings.length === 0) {
    return <p className="rounded-xl bg-gray-50 px-3 py-3 text-sm text-gray-600">{t('readings.empty')}</p>;
  }
  const newestFirst = [...readings].sort((a, b) => b.taken_at.localeCompare(a.taken_at));
  return (
    <ol className="divide-y divide-gray-100" aria-label={t('readings.title')}>
      {newestFirst.map((r) => (
        <li key={r.id} className="flex items-center gap-3 py-2.5" data-testid="reading-row">
          <span className={`tabular w-20 shrink-0 text-2xl font-extrabold ${r.temp_c >= hotAboveC ? 'text-critical' : 'text-gray-900'}`}>
            {f.number(r.temp_c, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-800">{f.dateTime(r.taken_at)}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
              <SourceChip source={r.source} />
              {r.synced && r.hash ? (
                <span className="font-mono" title={r.hash}>
                  #{r.seq} · {shortId(r.hash, 10)}…
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500" />
                  {t('readings.unsynced')}
                </span>
              )}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default ReadingsTimeline;
