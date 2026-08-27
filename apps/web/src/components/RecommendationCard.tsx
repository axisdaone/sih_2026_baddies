/**
 * "Sell at Mandi A" card (PRD F5): top mandi, distance / travel, expected ₹, uplift vs nearest, with
 * the honesty labels (stale price, SIMULATED, cached-at when offline) and a Why? link.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { BatchRow } from '../db';
import { useFormat } from '../i18n/useFormat';
import { useRecommendation } from '../hooks/useRecommendation';
import { useAppStatus } from '../state/appStatus';
import { Button } from './Button';
import { SimBadge } from './SimBadge';

export interface RecommendationCardProps {
  batch: BatchRow;
  /** Bumps a refetch when readings are added. */
  readingsCount: number;
}

export function RecommendationCard({ batch, readingsCount }: RecommendationCardProps): JSX.Element {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const { online } = useAppStatus();
  const { recommendation: rec, cachedAt, fromCache, loading, error, refresh } = useRecommendation(batch.id, `${readingsCount}`);
  const top = rec?.top ?? null;

  return (
    <section className="card border-2 border-brand-200" aria-label={t('rec.title')} data-testid="recommendation-card" aria-busy={loading || undefined}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('rec.title')}</h2>
        {rec?.simulated && <SimBadge />}
      </header>

      {!rec && loading && <p className="text-sm text-gray-600">{t('rec.loading')}</p>}
      {!rec && !loading && (
        <p className="rounded-xl bg-gray-50 px-3 py-3 text-sm text-gray-700">
          {online ? t('rec.unavailable') : t('rec.offline_no_cache')}
          {error && online && <span className="mt-1 block text-xs text-gray-500">{error}</span>}
        </p>
      )}

      {rec && !top && (
        <p className="rounded-xl bg-red-50 px-3 py-3 text-sm font-semibold text-red-900">
          {/* Unknown future codes fall back to a translated sentence, never the raw code. */}
          {t(`reasons.${rec.reason ?? 'no_feasible_mandi'}`, { defaultValue: t('reasons.no_feasible_mandi') })}
        </p>
      )}

      {rec && top && (
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">{t('rec.sell_at')}</p>
          <p className="text-3xl font-extrabold text-brand-900">{top.name}</p>
          <p className="text-sm text-gray-600">{top.district}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-gray-500">{t('rec.distance')}</dt>
            <dd className="tabular font-semibold">
              {f.number(top.distance_km, { maximumFractionDigits: 0 })} km · {f.hours(top.travel_hours)}
            </dd>
            <dt className="text-gray-500">{t('rec.price')}</dt>
            <dd className="tabular font-semibold">
              {top.modal_price_per_quintal != null ? f.inr(top.modal_price_per_quintal) : '—'}/{t('common:quintal')}
              {top.price_is_stale && <span className="ml-1 chip bg-amber-100 text-amber-900">{t('rec.stale')}</span>}
            </dd>
            <dt className="text-gray-500">{t('rec.expected_value')}</dt>
            <dd className="tabular text-xl font-extrabold text-brand-900">{f.inr(top.expected_value_inr)}</dd>
            {rec.uplift_vs_nearest_pct !== null && rec.nearest && rec.nearest.mandi_id !== top.mandi_id && (
              <>
                <dt className="text-gray-500">{t('rec.uplift', { mandi: rec.nearest.name })}</dt>
                <dd className={`tabular font-semibold ${rec.uplift_vs_nearest_pct >= 0 ? 'text-fresh' : 'text-critical'}`}>
                  {f.percent(rec.uplift_vs_nearest_pct / 100, { maximumFractionDigits: 0, signDisplay: 'exceptZero' })}
                </dd>
              </>
            )}
            {rec.nearest && rec.nearest.mandi_id === top.mandi_id && (
              <>
                <dt className="text-gray-500">{t('rec.nearest_label')}</dt>
                <dd className="font-semibold">{t('rec.is_nearest')}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {rec && (
        <p className="mt-3 text-xs text-gray-500">
          {fromCache || !online ? t('rec.cached_at', { time: f.dateTime(cachedAt ?? rec.computed_at) }) : t('rec.computed_at', { time: f.dateTime(rec.computed_at) })}
          {top && ` · ${t('rec.price_source', { source: t(`price_source.${top.price_source}`, { defaultValue: top.price_source }) })}`}
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Link to={`/batch/${batch.id}/why`} className="btn-secondary" aria-disabled={!rec} onClick={(e) => !rec && e.preventDefault()}>
          {t('rec.why')}
        </Link>
        <Button variant="secondary" onClick={refresh} disabled={!online || loading} loading={loading && !!rec}>
          {t('rec.refresh')}
        </Button>
      </div>
    </section>
  );
}

export default RecommendationCard;
