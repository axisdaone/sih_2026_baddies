/** Urgency-sorted batch list with status filter chips; tapping a row selects it for the map. */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { SimBadge } from '../SimBadge';
import { STATUS_CLASS, StatusChip } from '../pass/StatusChip';
import type { ShelfLifeStatus } from '../../types';
import type { UrgencyItem } from './useEstimates';

export type StatusFilter = 'all' | ShelfLifeStatus;
export const STATUS_FILTERS: StatusFilter[] = ['all', 'critical', 'warning', 'fresh', 'spoiled'];

export interface BatchListProps {
  items: UrgencyItem[];
  filter: StatusFilter;
  onFilter: (f: StatusFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function applyFilter(items: UrgencyItem[], filter: StatusFilter): UrgencyItem[] {
  if (filter === 'all') return items;
  return items.filter((i) => i.estimate?.status === filter || (filter === 'spoiled' && i.batch.status === 'spoiled'));
}

export function BatchList({ items, filter, onFilter, selectedId, onSelect }: BatchListProps): JSX.Element {
  const { t } = useTranslation('fpo');
  const f = useFormat();
  const visible = applyFilter(items, filter);
  return (
    <section aria-label={t('list.title')}>
      <div className="mb-2 flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('filter.label')}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            onClick={() => onFilter(s)}
            className={`min-h-10 shrink-0 rounded-full border px-4 text-sm font-semibold ${
              filter === s ? 'border-brand bg-brand text-white' : 'border-gray-300 bg-white text-gray-700'
            }`}
          >
            {s === 'all' ? t('filter.all') : t(`tiles.${s}`)}
          </button>
        ))}
      </div>
      {items.length === 0 && (
        <div className="card text-center text-gray-600">
          <p className="font-semibold">{t('list.empty')}</p>
          <p className="mt-1 text-sm">{t('list.empty_hint')}</p>
        </div>
      )}
      <ul className="flex flex-col gap-2" data-testid="batch-list">
        {visible.map(({ batch, estimate, pending, simulated }) => {
          const selected = batch.id === selectedId;
          const cls = estimate ? STATUS_CLASS[estimate.status] : null;
          const closed = batch.status !== 'open';
          return (
            <li key={batch.id}>
              <div
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={t('list.select', { name: `${t(`crop.${batch.crop}`, { defaultValue: batch.crop })} ${f.kg(batch.qty_kg)}` })}
                onClick={() => onSelect(batch.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(batch.id);
                  }
                }}
                className={`card flex cursor-pointer items-center gap-3 border-l-4 ${cls ? cls.border : 'border-gray-300'} ${
                  selected ? 'ring-2 ring-brand-600' : ''
                } ${closed ? 'opacity-70' : ''}`}
                data-testid="batch-row"
                data-batch-id={batch.id}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-bold">
                      {t(`crop.${batch.crop}`, { defaultValue: batch.crop })} · {f.kg(batch.qty_kg)}
                    </span>
                    {simulated && <SimBadge />}
                    {closed ? (
                      <span className="chip bg-gray-200 text-gray-700">{t(`batch_status.${batch.status}`)}</span>
                    ) : (
                      estimate && <StatusChip status={estimate.status} />
                    )}
                  </div>
                  <p className="text-sm text-gray-600">
                    {t('list.harvested')}: <span className="tabular">{f.dateTime(batch.harvested_at)}</span>
                    {batch.origin_lat === null && <span className="ml-2 text-xs text-amber-700">{t('list.no_location')}</span>}
                  </p>
                  <p className={`text-sm font-semibold tabular ${cls ? cls.text : 'text-gray-500'}`}>
                    {estimate
                      ? `${t('list.remaining')}: ${f.hoursRange(estimate.remaining_hours.low, estimate.remaining_hours.high, estimate.remaining_hours.mid)}`
                      : pending
                        ? t('list.estimating')
                        : t('list.no_estimate')}
                  </p>
                </div>
                <Link
                  to={`/batch/${batch.id}`}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl text-brand hover:bg-brand-50"
                  aria-label={`${t('list.select', { name: '' })} →`}
                  onClick={(e) => e.stopPropagation()}
                >
                  ›
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default BatchList;
