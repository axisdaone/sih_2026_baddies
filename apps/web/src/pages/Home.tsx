/**
 * Home: open batches sorted most-urgent first (remaining_hours.mid asc), each with a live range,
 * plus a collapsed list of closed batches. Empty state points at "+ Log harvest" and demo data.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BatchCard } from '../components/BatchCard';
import { useBatches } from '../hooks/useBatch';
import { useShelfLifeMap } from '../hooks/useShelfLife';

export default function Home(): JSX.Element {
  const { t } = useTranslation(['common', 'batch']);
  const { batches, readingsByBatch, loading } = useBatches();
  const open = useMemo(() => batches.filter((b) => b.status === 'open'), [batches]);
  const closed = useMemo(() => batches.filter((b) => b.status !== 'open'), [batches]);
  const { estimates } = useShelfLifeMap(open, readingsByBatch);

  const sortedOpen = useMemo(() => {
    const mid = (id: string) => estimates[id]?.remaining_hours.mid ?? Number.POSITIVE_INFINITY;
    return [...open].sort((a, b) => mid(a.id) - mid(b.id) || b.harvested_at.localeCompare(a.harvested_at));
  }, [open, estimates]);

  return (
    <div className="page">
      <div className="mb-3 flex items-center justify-between">
        <h1>{t('common:titles.home')}</h1>
        {open.length > 0 && <span className="text-sm font-semibold text-gray-500">{t('batch:home.open_count', { count: open.length })}</span>}
      </div>

      {loading && <p className="text-gray-500">{t('common:loading')}</p>}

      {!loading && batches.length === 0 && (
        <section className="card mt-6 text-center" data-testid="home-empty">
          <p className="text-xl font-bold">{t('batch:home.empty_title')}</p>
          <p className="mt-1 text-gray-600">{t('batch:home.empty_body')}</p>
          <Link to="/new" className="btn-primary mt-5 w-full text-xl">
            + {t('batch:home.log_harvest')}
          </Link>
          <p className="mt-4 text-sm text-gray-500">
            {t('batch:home.demo_hint')}{' '}
            <Link to="/settings" className="font-semibold text-brand underline">
              {t('batch:home.demo_link')}
            </Link>
          </p>
        </section>
      )}

      {sortedOpen.length > 0 && (
        <ul className="space-y-3" aria-label={t('batch:home.open_list')}>
          {sortedOpen.map((b) => (
            <li key={b.id}>
              <BatchCard batch={b} readings={readingsByBatch[b.id] ?? []} estimate={estimates[b.id] ?? null} />
            </li>
          ))}
        </ul>
      )}

      {!loading && batches.length > 0 && (
        <Link to="/new" className="btn-primary mt-4 w-full text-xl">
          + {t('batch:home.log_harvest')}
        </Link>
      )}

      {closed.length > 0 && (
        <details className="mt-6">
          <summary className="min-h-12 cursor-pointer text-base font-semibold text-gray-600">{t('batch:home.closed', { count: closed.length })}</summary>
          <ul className="mt-2 space-y-3">
            {closed.map((b) => (
              <li key={b.id}>
                <BatchCard batch={b} readings={readingsByBatch[b.id] ?? []} estimate={null} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
