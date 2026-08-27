/**
 * Batch screen: header, live CountdownRange, actions (add reading, Quality Pass), recommendation,
 * SIMULATED player, readings timeline, sold / discard. Everything reads from Dexie live queries.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AddReadingSheet } from '../components/AddReadingSheet';
import { Button } from '../components/Button';
import { CountdownRange } from '../components/CountdownRange';
import { CropIcon } from '../components/CropIcon';
import { ReadingsTimeline } from '../components/ReadingsTimeline';
import { RecommendationCard } from '../components/RecommendationCard';
import { SimBadge } from '../components/SimBadge';
import { SimPlayer } from '../components/SimPlayer';
import { BatchStatusChip } from '../components/StatusPill';
import { notify } from '../alerts/toast';
import { PROTOCOLS } from '../data';
import { isStorageError } from '../db/errors';
import { addReadingLocal, hasSimReadings, patchBatchLocal } from '../db/repo';
import { useBatch } from '../hooks/useBatch';
import { useShelfLife } from '../hooks/useShelfLife';
import { useFormat } from '../i18n/useFormat';
import { drain } from '../sync';
import type { BatchStatus } from '../types';

export default function BatchDetail(): JSX.Element {
  const { t } = useTranslation(['batch', 'common']);
  const f = useFormat();
  const { id } = useParams<{ id: string }>();
  const { batch, readings, loading } = useBatch(id);
  const { estimate, source, loading: estimating, error: engineError } = useShelfLife(batch, readings);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirm, setConfirm] = useState<Extract<BatchStatus, 'sold' | 'discarded'> | null>(null);

  if (loading) {
    return (
      <div className="page">
        <h1>{t('common:titles.batch')}</h1>
        <p className="mt-2 text-gray-500">{t('common:loading')}</p>
      </div>
    );
  }
  if (!batch) {
    return (
      <div className="page">
        <h1>{t('common:titles.batch')}</h1>
        <p className="mt-2 text-gray-600">{t('batch:detail.not_found')}</p>
        <Link to="/" className="btn-secondary mt-6">
          {t('common:go_home')}
        </Link>
      </div>
    );
  }

  const protocol = PROTOCOLS[batch.protocol_id];
  const isOpen = batch.status === 'open';
  const cropName = t(`batch:crops.${batch.crop}`, { defaultValue: batch.crop });

  // Storage failures get a translated explanation (never Dexie's raw message); the sheet stays open.
  const explain = (err: unknown) => notify.error(isStorageError(err) ? t('common:storage_unavailable') : t('common:error_generic'));
  const addReading = async (tempC: number) => {
    try {
      await addReadingLocal(batch.id, tempC, 'manual', batch.origin_geohash);
    } catch (err) {
      explain(err);
      throw err;
    }
    void drain();
  };
  const setStatus = async (status: BatchStatus) => {
    try {
      await patchBatchLocal(batch.id, { status });
    } catch (err) {
      explain(err);
      return;
    }
    setConfirm(null);
    void drain();
  };

  return (
    <div className="page space-y-4">
      <header className="flex items-center gap-3">
        <CropIcon crop={batch.crop} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2">
            <span>
              {cropName} · {f.kg(batch.qty_kg)}
            </span>
            <BatchStatusChip status={batch.status} />
            {hasSimReadings(readings) && <SimBadge />}
            {!batch.synced && <span role="img" aria-label={t('batch:card.unsynced')} title={t('batch:card.unsynced')} className="h-2.5 w-2.5 rounded-full bg-amber-500" />}
          </h1>
          <p className="text-sm text-gray-600">{t('batch:detail.harvested', { time: f.dateTime(batch.harvested_at) })}</p>
          {batch.origin_lat == null && <p className="text-xs text-amber-800">{t('batch:detail.origin_assumed')}</p>}
        </div>
      </header>

      {estimate ? (
        <CountdownRange estimate={estimate} source={source} />
      ) : (
        <section className="card text-gray-600" aria-busy={estimating}>
          {estimating ? t('batch:card.estimating') : t('batch:detail.no_estimate')}
          {engineError && <span className="mt-1 block text-xs text-gray-400">{engineError}</span>}
        </section>
      )}

      {!isOpen && <p className="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-700">{t('batch:detail.closed_note', { status: t(`batch:batch_status.${batch.status}`) })}</p>}

      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => setSheetOpen(true)} disabled={!isOpen} data-testid="add-reading">
          <span aria-hidden="true">🌡</span> {t('batch:detail.add_reading')}
        </Button>
        <Link to={`/pass/${batch.id}`} className="btn-secondary">
          {t('batch:detail.quality_pass')}
        </Link>
      </div>

      <RecommendationCard batch={batch} readingsCount={readings.length} />

      {isOpen && <SimPlayer batch={batch} readings={readings} />}

      <section className="card" aria-labelledby="readings-heading">
        <h2 id="readings-heading" className="mb-2 text-lg font-semibold">
          {t('batch:readings.title')} ({f.number(readings.length)})
        </h2>
        <ReadingsTimeline readings={readings} hotAboveC={protocol?.hard_thresholds.find((h) => h.type === 'max_temp')?.value_c ?? 40} />
      </section>

      {isOpen && (
        <section className="card" aria-label={t('batch:detail.close_batch')}>
          <h2 className="mb-2 text-lg font-semibold">{t('batch:detail.close_batch')}</h2>
          {confirm ? (
            <div>
              <p className="mb-3 text-sm text-gray-700">{confirm === 'sold' ? t('batch:detail.confirm_sold') : t('batch:detail.confirm_discard')}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => setConfirm(null)}>
                  {t('common:cancel')}
                </Button>
                <Button variant={confirm === 'sold' ? 'primary' : 'danger'} onClick={() => void setStatus(confirm)}>
                  {confirm === 'sold' ? t('batch:detail.mark_sold') : t('batch:detail.discard')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setConfirm('sold')}>
                <span aria-hidden="true">✓</span> {t('batch:detail.mark_sold')}
              </Button>
              <Button variant="danger" onClick={() => setConfirm('discarded')}>
                <span aria-hidden="true">✕</span> {t('batch:detail.discard')}
              </Button>
            </div>
          )}
        </section>
      )}

      {batch.notes && (
        <section className="card">
          <h2 className="mb-1 text-lg font-semibold">{t('batch:new.notes')}</h2>
          <p className="text-sm text-gray-700">{batch.notes}</p>
        </section>
      )}

      <p className="break-all font-mono text-[10px] text-gray-400">{batch.id}</p>

      <AddReadingSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onSave={addReading} />
    </div>
  );
}
