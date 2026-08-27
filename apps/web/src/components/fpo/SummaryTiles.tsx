/** FPO summary tiles: kg at risk (critical) + batch counts by status. */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import type { ShelfLifeStatus } from '../../types';
import { SimBadge } from '../SimBadge';
import type { UrgencyItem } from './useEstimates';

const STATUSES: ShelfLifeStatus[] = ['fresh', 'warning', 'critical', 'spoiled'];
const TILE_CLASS: Record<ShelfLifeStatus, string> = {
  fresh: 'bg-green-50 text-green-900',
  warning: 'bg-amber-50 text-amber-900',
  critical: 'bg-orange-50 text-orange-900',
  spoiled: 'bg-red-50 text-red-900',
};

export interface Summary {
  kgAtRisk: number;
  counts: Record<ShelfLifeStatus, number>;
  total: number;
  /** Any batch in the aggregate has simulated readings → the headline metric carries the chip. */
  anySim: boolean;
}

export function summarise(items: UrgencyItem[]): Summary {
  const counts: Record<ShelfLifeStatus, number> = { fresh: 0, warning: 0, critical: 0, spoiled: 0 };
  let kgAtRisk = 0;
  let anySim = false;
  for (const item of items) {
    if (item.simulated) anySim = true;
    if (item.batch.status !== 'open' || !item.estimate) continue;
    counts[item.estimate.status] += 1;
    if (item.estimate.status === 'critical') kgAtRisk += item.batch.qty_kg;
  }
  return { kgAtRisk, counts, total: items.length, anySim };
}

export function SummaryTiles({ items }: { items: UrgencyItem[] }): JSX.Element {
  const { t } = useTranslation('fpo');
  const f = useFormat();
  const { kgAtRisk, counts, total, anySim } = summarise(items);
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="summary-tiles">
      <div className="card col-span-2 flex items-baseline justify-between gap-2 bg-orange-50" title={t('tiles.kg_at_risk_hint')}>
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-orange-900">
          {t('tiles.kg_at_risk')}
          {anySim && <SimBadge />}
        </span>
        <span className="text-3xl font-bold tabular text-critical" data-testid="kg-at-risk">
          {f.number(kgAtRisk)}
        </span>
      </div>
      <div className="card flex items-baseline justify-between">
        <span className="text-sm text-gray-600">{t('tiles.batches')}</span>
        <span className="text-2xl font-bold tabular">{f.number(total)}</span>
      </div>
      {STATUSES.map((s) => (
        <div key={s} className={`card flex items-baseline justify-between ${TILE_CLASS[s]}`}>
          <span className="text-sm font-medium">{t(`tiles.${s}`)}</span>
          <span className="text-2xl font-bold tabular" data-testid={`count-${s}`}>
            {f.number(counts[s])}
          </span>
        </div>
      ))}
    </div>
  );
}

export default SummaryTiles;
