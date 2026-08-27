/** Home-list tile: crop icon, qty, harvested (IST), status pill, range line, SIMULATED + unsynced markers. */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { BatchRow, ReadingRow } from '../db';
import { hasSimReadings } from '../db/repo';
import { useFormat } from '../i18n/useFormat';
import type { ShelfLifeEstimate } from '../types';
import { CropIcon } from './CropIcon';
import { SimBadge } from './SimBadge';
import { BatchStatusChip, STATUS_BORDER, StatusPill } from './StatusPill';

export interface BatchCardProps {
  batch: BatchRow;
  readings: ReadingRow[];
  estimate: ShelfLifeEstimate | null;
}

export function BatchCard({ batch, readings, estimate }: BatchCardProps): JSX.Element {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const closed = batch.status !== 'open';
  const border = estimate && !closed ? STATUS_BORDER[estimate.status] : 'border-gray-300';
  return (
    <Link
      to={`/batch/${batch.id}`}
      className={`card block border-l-8 ${border} active:bg-gray-50`}
      aria-label={t('card.aria', { crop: t(`crops.${batch.crop}`, { defaultValue: batch.crop }), qty: f.kg(batch.qty_kg) })}
      data-testid="batch-card"
    >
      <div className="flex items-center gap-3">
        <CropIcon crop={batch.crop} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-xl font-bold">
              {t(`crops.${batch.crop}`, { defaultValue: batch.crop })} · {f.kg(batch.qty_kg)}
            </p>
            {!batch.synced && <span role="img" aria-label={t('card.unsynced')} title={t('card.unsynced')} className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />}
          </div>
          <p className="text-sm text-gray-600">{t('card.harvested', { time: f.dateTime(batch.harvested_at) })}</p>
        </div>
        {closed ? <BatchStatusChip status={batch.status} /> : estimate ? <StatusPill status={estimate.status} /> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {estimate ? (
          <p className="tabular text-base font-semibold text-gray-800" data-testid="card-range">
            {f.hoursRange(estimate.remaining_hours.low, estimate.remaining_hours.high, estimate.remaining_hours.mid)}
          </p>
        ) : closed ? null : (
          <p className="text-sm text-gray-500">{t('card.estimating')}</p>
        )}
        {/* No temperature has been read: the range assumes the protocol's ambient — say so (text, not colour). */}
        {estimate && !closed && estimate.current_temp_assumed && (
          <span className="chip bg-amber-100 text-amber-900" data-testid="card-assumed" title={t('countdown.assumed_note', { temp: f.number(estimate.current_temp_c) })}>
            {t('card.temp_assumed')}
          </span>
        )}
        {hasSimReadings(readings) && <SimBadge />}
      </div>
    </Link>
  );
}

export default BatchCard;
