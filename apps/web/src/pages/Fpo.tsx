/**
 * FPO dashboard (/fpo, PRD F10): every local batch by urgency with live estimates, summary tiles,
 * status filter, and a Leaflet map of batches vs mandis with the cached recommendation line.
 */
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db } from '@/db';
import { BatchList, type StatusFilter } from '@/components/fpo/BatchList';
import { FpoMap } from '@/components/fpo/FpoMap';
import { SummaryTiles } from '@/components/fpo/SummaryTiles';
import { sortByUrgency, useBatchEstimates, type UrgencyItem } from '@/components/fpo/useEstimates';
import type { Recommendation } from '@/types';

/** meta key under which the core pages cache the last Recommendation for a batch. */
export const recMetaKey = (batchId: string): string => `rec:${batchId}`;

export default function Fpo(): JSX.Element {
  const { t } = useTranslation('fpo');
  const { t: tc } = useTranslation('common');
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const readings = useLiveQuery(() => db.readings.toArray(), []);
  const prices = useLiveQuery(() => db.prices.toArray(), [], []);
  const estimates = useBatchEstimates(batches, readings);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const recommendation = useLiveQuery(
    async () => (selectedId ? ((await db.getMeta<Recommendation>(recMetaKey(selectedId))) ?? null) : null),
    [selectedId],
    null,
  );

  const items = useMemo<UrgencyItem[]>(
    () =>
      sortByUrgency(
        (batches ?? []).map((batch) => {
          const entry = estimates[batch.id];
          return { batch, estimate: entry?.estimate ?? batch.shelf_life ?? null, pending: !entry, simulated: entry?.simulated ?? false };
        }),
      ),
    [batches, estimates],
  );

  const effectiveSelected = selectedId ?? items[0]?.batch.id ?? null;

  return (
    <div className="page flex flex-col gap-4">
      <header>
        <h1>{tc('titles.fpo')}</h1>
        <p className="mt-1 text-sm text-gray-600">{t('subtitle')}</p>
      </header>

      <SummaryTiles items={items} />

      <section aria-label={t('map.title')}>
        <h2 className="mb-2 text-lg font-semibold">{t('map.title')}</h2>
        <FpoMap items={items} selectedId={effectiveSelected} onSelect={setSelectedId} prices={prices ?? []} recommendation={recommendation ?? null} />
        <p className="mt-1 text-xs text-gray-500">
          {t('map.hint')} {t('map.line_hint')}.
        </p>
      </section>

      <BatchList items={items} filter={filter} onFilter={setFilter} selectedId={effectiveSelected} onSelect={setSelectedId} />
      <p className="text-xs text-gray-500">{t('simulated_hint')}</p>
    </div>
  );
}
