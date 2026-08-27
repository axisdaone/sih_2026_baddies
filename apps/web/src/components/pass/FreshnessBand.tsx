/** Freshness band: status colour, remaining-hours RANGE (never a scalar), likely end, confidence. */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { SimBadge } from '../SimBadge';
import { STATUS_CLASS, StatusChip } from './StatusChip';
import type { DecayProtocol, ShelfLifeEstimate } from '../../types';

export interface FreshnessBandProps {
  estimate: ShelfLifeEstimate | null;
  protocol?: DecayProtocol;
  simulated?: boolean;
}

export function FreshnessBand({ estimate, protocol, simulated = false }: FreshnessBandProps): JSX.Element {
  const { t } = useTranslation('pass');
  const f = useFormat();
  if (!estimate) {
    return (
      <section className="card" aria-label={t('freshness')}>
        <h2 className="text-lg font-semibold">{t('freshness')}</h2>
        <p className="mt-2 text-sm text-gray-600">{t('timeline.no_readings', { temp: f.number(protocol?.default_ambient_c ?? 30) })}</p>
      </section>
    );
  }
  const cls = STATUS_CLASS[estimate.status];
  const pct = Math.round(Math.max(0, Math.min(1, estimate.remaining_fraction)) * 100);
  const { low, mid, high } = estimate.remaining_hours;
  return (
    <section className={`card border-2 ${cls.border}`} aria-label={t('freshness')} data-testid="freshness-band">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('freshness')}</h2>
        <div className="flex items-center gap-2">
          {simulated && <SimBadge />}
          <StatusChip status={estimate.status} />
        </div>
      </header>
      <p className="text-sm text-gray-600">{t('remaining')}</p>
      <p className={`text-2xl font-bold tabular ${cls.text}`}>{f.hoursRange(low, high, mid)}</p>
      <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`h-full rounded-full ${cls.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-600">{t('expected_end')}</dt>
        <dd className="font-medium tabular">{f.dateTime(estimate.expected_end.mid)}</dd>
        <dt className="text-gray-600">{t('confidence.label')}</dt>
        <dd className="font-medium">{t(`confidence.${estimate.confidence}`)}</dd>
        <dt className="text-gray-600">{t('current_temp')}</dt>
        <dd className="font-medium tabular">{f.number(estimate.current_temp_c, { maximumFractionDigits: 1 })} °C</dd>
      </dl>
      {estimate.current_temp_assumed && (
        <p className="mt-2 text-sm text-amber-800">{t('assumed_temp', { temp: f.number(estimate.current_temp_c, { maximumFractionDigits: 1 }) })}</p>
      )}
      {estimate.breach && (
        <p className="mt-2 text-sm font-semibold text-spoiled">
          {t('breach', { label: estimate.breach.label ?? estimate.breach.type, temp: f.number(estimate.breach.value_c, { maximumFractionDigits: 1 }) })}
        </p>
      )}
      <p className="mt-3 text-xs text-gray-500">{t('range_note')}</p>
    </section>
  );
}

export default FreshnessBand;
