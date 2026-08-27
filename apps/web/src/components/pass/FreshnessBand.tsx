/** Freshness band: status colour, remaining-hours RANGE (never a scalar), likely end, confidence. */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { SimBadge } from '../SimBadge';
import { STATUS_CLASS, StatusChip } from '../StatusPill';
import type { DecayProtocol, ShelfLifeEstimate } from '../../types';

export interface FreshnessBandProps {
  estimate: ShelfLifeEstimate | null;
  protocol?: DecayProtocol;
  simulated?: boolean;
}

export function FreshnessBand({ estimate, protocol, simulated = false }: FreshnessBandProps): JSX.Element {
  // `batch` carries the translated breach labels (heat_damage / freeze / …) shared with CountdownRange.
  const { t } = useTranslation(['pass', 'batch']);
  const f = useFormat();
  if (!estimate) {
    return (
      <section className="card" aria-label={t('pass:freshness')}>
        <h2 className="text-lg font-semibold">{t('pass:freshness')}</h2>
        <p className="mt-2 text-sm text-gray-600">{t('pass:timeline.no_readings', { temp: f.number(protocol?.default_ambient_c ?? 30) })}</p>
      </section>
    );
  }
  const cls = STATUS_CLASS[estimate.status];
  const pct = Math.round(Math.max(0, Math.min(1, estimate.remaining_fraction)) * 100);
  const { low, mid, high } = estimate.remaining_hours;
  const breachCode = estimate.breach ? (estimate.breach.label ?? estimate.breach.type) : null;
  return (
    <section className={`card border-2 ${cls.border}`} aria-label={t('pass:freshness')} data-testid="freshness-band">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('pass:freshness')}</h2>
        <div className="flex items-center gap-2">
          {simulated && <SimBadge />}
          <StatusChip status={estimate.status} />
        </div>
      </header>
      <p className="text-sm text-gray-600">{t('pass:remaining')}</p>
      <p className={`text-2xl font-bold tabular ${cls.text}`}>{f.hoursRange(low, high, mid)}</p>
      <div
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-gray-200"
        role="progressbar"
        aria-label={t('pass:remaining')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={f.percent(estimate.remaining_fraction)}
      >
        <div className={`h-full rounded-full ${cls.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-600">{t('pass:expected_end')}</dt>
        <dd className="font-medium tabular">{f.dateTime(estimate.expected_end.mid)}</dd>
        <dt className="text-gray-600">{t('pass:confidence.label')}</dt>
        <dd className="font-medium">{t(`pass:confidence.${estimate.confidence}`)}</dd>
        <dt className="text-gray-600">{t('pass:current_temp')}</dt>
        <dd className="font-medium tabular">{f.number(estimate.current_temp_c, { maximumFractionDigits: 1 })} °C</dd>
      </dl>
      {estimate.current_temp_assumed && (
        <p className="mt-2 text-sm text-amber-800">{t('pass:assumed_temp', { temp: f.number(estimate.current_temp_c, { maximumFractionDigits: 1 }) })}</p>
      )}
      {estimate.breach && breachCode && (
        <p className="mt-2 text-sm font-semibold text-spoiled" data-testid="freshness-breach">
          {t('pass:breach', {
            label: t(`batch:breach.${breachCode}`, { defaultValue: breachCode }),
            temp: f.number(estimate.breach.value_c, { maximumFractionDigits: 1 }),
          })}
        </p>
      )}
      <p className="mt-3 text-xs text-gray-500">{t('pass:range_note')}</p>
    </section>
  );
}

export default FreshnessBand;
