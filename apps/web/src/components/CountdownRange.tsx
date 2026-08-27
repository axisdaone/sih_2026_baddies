/**
 * The shelf-life countdown: big "most likely N h", the low–high band as a bar in the status colour,
 * confidence label, expected end (mid) in IST, and the "assumed temperature" note (contract §9:
 * shelf life is always a range).
 */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';
import type { ShelfLifeEstimate } from '../types';
import { STATUS_BAR, STATUS_TEXT, StatusPill } from './StatusPill';

export interface CountdownRangeProps {
  estimate: ShelfLifeEstimate;
  /** 'server' when the value came from the last sync rather than the on-device engine. */
  source?: 'local' | 'server' | null;
  className?: string;
}

export function CountdownRange({ estimate, source = 'local', className = '' }: CountdownRangeProps): JSX.Element {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const { low, mid, high } = estimate.remaining_hours;
  const remainingPct = Math.round(Math.max(0, Math.min(1, estimate.remaining_fraction)) * 100);
  // Band geometry: position low/mid/high on a 0..high axis so the bar reads as "how much is left".
  const axisMax = Math.max(high, 1);
  const pct = (h: number) => `${Math.max(0, Math.min(100, (h / axisMax) * 100))}%`;

  return (
    <section
      className={`card border-l-8 ${className}`}
      style={{ borderLeftColor: 'currentColor' }}
      aria-label={t('countdown.aria')}
      data-testid="countdown-range"
    >
      <div className={STATUS_TEXT[estimate.status]}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">{t('countdown.most_likely')}</p>
            <p className="tabular text-5xl font-extrabold leading-none">{f.hours(mid)}</p>
          </div>
          <StatusPill status={estimate.status} />
        </div>
      </div>

      <p className="tabular mt-3 text-base font-semibold text-gray-800" data-testid="range-line">
        {f.hoursRange(low, high, mid)}
      </p>

      <div className="relative mt-3 h-4 w-full overflow-hidden rounded-full bg-gray-200" role="img" aria-label={t('countdown.band_aria', { low: f.hours(low), high: f.hours(high) })}>
        <div className={`absolute inset-y-0 rounded-full opacity-40 ${STATUS_BAR[estimate.status]}`} style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})` }} />
        <div className={`absolute inset-y-0 w-1.5 -translate-x-1/2 rounded-full ${STATUS_BAR[estimate.status]}`} style={{ left: pct(mid) }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-gray-500">
        <span>{t('countdown.pessimistic')}</span>
        <span>{t('countdown.optimistic')}</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-gray-500">{t('countdown.remaining_pct')}</dt>
        <dd className="tabular font-semibold">{f.percent(estimate.remaining_fraction)}</dd>
        <dt className="text-gray-500">{t('countdown.confidence')}</dt>
        <dd className="font-semibold">{t(`confidence.${estimate.confidence}`)}</dd>
        {/* The hours are a range, so the end time is too: mid is "most likely", low–high is the spread. */}
        <dt className="text-gray-500">
          {t('countdown.expected_end')} <span className="text-xs">({t('countdown.most_likely').toLowerCase()})</span>
        </dt>
        <dd className="font-semibold" data-testid="expected-end">
          {f.dateTime(estimate.expected_end.mid)}
          <span className="tabular block text-xs font-normal text-gray-500">
            {f.dateTime(estimate.expected_end.low)} – {f.dateTime(estimate.expected_end.high)}
          </span>
        </dd>
        <dt className="text-gray-500">{t('countdown.current_temp')}</dt>
        <dd className="tabular font-semibold">
          {f.number(estimate.current_temp_c)} °C
          {estimate.current_temp_assumed && <span className="ml-1 text-xs font-normal text-gray-500">({t('countdown.assumed')})</span>}
        </dd>
      </dl>

      {estimate.current_temp_assumed && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900" role="note">
          {t('countdown.assumed_note', { temp: f.number(estimate.current_temp_c) })}
        </p>
      )}
      {estimate.breach && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" role="alert">
          {t('countdown.breach', { label: t(`breach.${estimate.breach.label ?? estimate.breach.type}`, { defaultValue: estimate.breach.label ?? estimate.breach.type }), temp: f.number(estimate.breach.value_c) })}
        </p>
      )}
      {source === 'server' && <p className="mt-2 text-xs text-gray-500">{t('countdown.from_server')}</p>}
      <p className="sr-only">
        {t('countdown.remaining_pct')}: {f.percent(remainingPct / 100)}
      </p>
    </section>
  );
}

export default CountdownRange;
