/**
 * Explanation screen (PRD goal 3): every candidate mandi with the full payload — price (+ reported
 * date, stale, source), distance & travel, spoilage at arrival, transport cost, expected value,
 * feasible / rejected reasons — plus the constants and the formula in words.
 */
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SimBadge } from '../components/SimBadge';
import { useBatch } from '../hooks/useBatch';
import { useRecommendation } from '../hooks/useRecommendation';
import { useFormat } from '../i18n/useFormat';
import type { MandiCandidate, Recommendation } from '../types';

type Role = 'top' | 'alternative' | 'nearest' | 'rejected';
interface Row {
  candidate: MandiCandidate;
  roles: Role[];
}

/** Flatten a recommendation into ordered rows; a mandi that is both top and nearest gets both tags. */
export function candidateRows(rec: Recommendation): Row[] {
  const rows: Row[] = [];
  const add = (c: MandiCandidate | null, role: Role) => {
    if (!c) return;
    const existing = rows.find((r) => r.candidate.mandi_id === c.mandi_id);
    if (existing) existing.roles.push(role);
    else rows.push({ candidate: c, roles: [role] });
  };
  add(rec.top, 'top');
  rec.alternatives.forEach((c) => add(c, 'alternative'));
  add(rec.nearest, 'nearest');
  rec.rejected.forEach((c) => add(c, 'rejected'));
  return rows;
}

const ROLE_CLASS: Record<Role, string> = {
  top: 'bg-brand text-white',
  alternative: 'bg-brand-100 text-brand-900',
  nearest: 'bg-sky-100 text-sky-900',
  rejected: 'bg-gray-200 text-gray-700',
};

export default function Why(): JSX.Element {
  const { t } = useTranslation(['batch', 'common']);
  const f = useFormat();
  const { id } = useParams<{ id: string }>();
  const { batch } = useBatch(id);
  const { recommendation: rec, cachedAt, fromCache, loading } = useRecommendation(id);
  const rows = useMemo(() => (rec ? candidateRows(rec) : []), [rec]);

  const reasonLabel = (code: string) => t(`batch:reasons.${code}`, { defaultValue: code });
  const sourceLabel = (code: string) => t(`batch:price_source.${code}`, { defaultValue: code });

  return (
    <div className="page space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1>{t('common:titles.why')}</h1>
        {rec?.simulated && <SimBadge />}
      </div>
      {id && (
        <Link to={`/batch/${id}`} className="text-sm font-semibold text-brand underline">
          ← {t('batch:why.back_to_batch')}
        </Link>
      )}

      {!rec && loading && <p className="text-gray-500">{t('common:loading')}</p>}
      {!rec && !loading && <p className="card text-gray-700">{t('batch:why.no_data')}</p>}

      {rec && (
        <>
          <section className="card text-sm text-gray-700">
            <p>{t('batch:why.intro')}</p>
            <p className="mt-2">
              {t('batch:why.shelf_life_used', {
                range: f.hoursRange(rec.shelf_life.remaining_hours.low, rec.shelf_life.remaining_hours.high, rec.shelf_life.remaining_hours.mid),
              })}
              {batch && ` · ${f.kg(batch.qty_kg)}`}
            </p>
            {rec.simulated && <p className="mt-2 text-purple-900">{t('batch:why.simulated_note')}</p>}
            {rec.reason && <p className="mt-2 font-semibold text-red-900">{reasonLabel(rec.reason)}</p>}
            <p className="mt-2 text-xs text-gray-500">
              {fromCache ? t('batch:rec.cached_at', { time: f.dateTime(cachedAt ?? rec.computed_at) }) : t('batch:rec.computed_at', { time: f.dateTime(rec.computed_at) })} · {rec.model_version}
            </p>
          </section>

          <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
            <table className="min-w-[640px] w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">{t('batch:why.mandi')}</th>
                  <th className="px-3 py-2">{t('batch:why.price')}</th>
                  <th className="px-3 py-2">{t('batch:why.distance')}</th>
                  <th className="px-3 py-2">{t('batch:why.spoilage_at_arrival')}</th>
                  <th className="px-3 py-2">{t('batch:why.transport_cost')}</th>
                  <th className="px-3 py-2">{t('batch:why.expected_value')}</th>
                  <th className="px-3 py-2">{t('batch:why.verdict')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(({ candidate: c, roles }) => (
                  <tr key={c.mandi_id} className={roles.includes('top') ? 'bg-brand-50/60' : c.feasible ? '' : 'text-gray-500'} data-testid="why-row">
                    <td className="px-3 py-2 align-top">
                      <p className="font-bold text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-500">{c.district}</p>
                      <p className="mt-1 flex flex-wrap gap-1">
                        {roles.map((r) => (
                          <span key={r} className={`chip ${ROLE_CLASS[r]}`}>
                            {t(`batch:why.role_${r}`)}
                          </span>
                        ))}
                      </p>
                    </td>
                    <td className="tabular px-3 py-2 align-top">
                      <p className="font-semibold">
                        {f.inr(c.modal_price_per_quintal)}/{t('common:quintal')}
                      </p>
                      <p className="text-xs text-gray-500">
                        {t('batch:why.reported_on', { date: c.price_reported_on })}
                        {c.price_is_stale && <span className="ml-1 chip bg-amber-100 text-amber-900">{t('batch:rec.stale')}</span>}
                      </p>
                      <p className="text-xs text-gray-500">{sourceLabel(c.price_source)}</p>
                    </td>
                    <td className="tabular px-3 py-2 align-top">
                      <p className="font-semibold">{f.number(c.distance_km, { maximumFractionDigits: 0 })} km</p>
                      <p className="text-xs text-gray-500">{t('batch:why.travel', { hours: f.hours(c.travel_hours) })}</p>
                      <p className="text-xs text-gray-500">{t('batch:why.straight', { km: f.number(c.straight_km, { maximumFractionDigits: 0 }) })}</p>
                    </td>
                    <td className="tabular px-3 py-2 align-top">
                      <p className="font-semibold">{f.percent(c.spoilage_at_arrival, { maximumFractionDigits: 1 })}</p>
                      <p className="text-xs text-gray-500">{t('batch:why.transit_temp', { temp: f.number(c.transit_temp_c) })}</p>
                    </td>
                    <td className="tabular px-3 py-2 align-top">
                      <p className="font-semibold">{f.inr(c.transport_cost_inr)}</p>
                    </td>
                    <td className="tabular px-3 py-2 align-top">
                      <p className="text-base font-extrabold text-gray-900">{f.inr(c.expected_value_inr)}</p>
                      <p className="text-xs text-gray-500">{t('batch:why.gross_value', { value: f.inr(c.gross_value_inr) })}</p>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <p className={`font-semibold ${c.feasible ? 'text-fresh' : 'text-critical'}`}>{c.feasible ? t('batch:why.feasible') : t('batch:why.infeasible')}</p>
                      <ul className="mt-1 text-xs text-gray-600">
                        {c.reasons.map((r) => (
                          <li key={r}>• {reasonLabel(r)}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="card">
            <h2 className="mb-2 text-lg font-semibold">{t('batch:why.constants')}</h2>
            <dl className="tabular grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-gray-500">{t('batch:why.road_factor')}</dt>
              <dd className="font-semibold">× {f.number(rec.constants.road_factor, { maximumFractionDigits: 2 })}</dd>
              <dt className="text-gray-500">{t('batch:why.avg_speed')}</dt>
              <dd className="font-semibold">{f.number(rec.constants.avg_speed_kmh)} km/h</dd>
              <dt className="text-gray-500">{t('batch:why.safety_factor')}</dt>
              <dd className="font-semibold">× {f.number(rec.constants.safety_factor, { maximumFractionDigits: 2 })}</dd>
              <dt className="text-gray-500">{t('batch:why.cost_per_km')}</dt>
              <dd className="font-semibold">{f.inr(rec.constants.transport_cost_per_km_inr)}/km</dd>
            </dl>
          </section>

          <section className="card">
            <h2 className="mb-2 text-lg font-semibold">{t('batch:why.formula_title')}</h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-700">
              <li>{t('batch:why.formula_distance', { factor: f.number(rec.constants.road_factor, { maximumFractionDigits: 2 }), speed: f.number(rec.constants.avg_speed_kmh) })}</li>
              <li>{t('batch:why.formula_feasible', { safety: f.number(rec.constants.safety_factor, { maximumFractionDigits: 2 }) })}</li>
              <li>{t('batch:why.formula_spoilage')}</li>
              <li>{t('batch:why.formula_value', { cost: f.inr(rec.constants.transport_cost_per_km_inr) })}</li>
              <li>{t('batch:why.formula_rank')}</li>
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
