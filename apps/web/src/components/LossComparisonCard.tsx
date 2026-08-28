/**
 * The "18 % → 7 %" pitch card (DEMO-SCRIPT 3:15): status quo vs FarmSignal for the same simulated
 * 500 kg tomato batch, from POST /demo/seed → loss_comparison (stored in Dexie meta by Settings →
 * load demo). Renders nothing until demo data has been loaded, so non-demo users never see it, and
 * always carries the SIMULATED chip plus the seed's honesty note (contract §6).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db } from '../db';
import { useFormat } from '../i18n/useFormat';
import type { LossComparison, LossComparisonSide } from '../types';
import { SimBadge } from './SimBadge';

/** Same literal as settings/DemoSection LOSS_COMPARISON_META_KEY (kept here so Home does not import that chunk). */
export const LOSS_COMPARISON_META_KEY = 'loss_comparison';

function isLossComparison(v: unknown): v is LossComparison {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<LossComparison>;
  const side = (s: unknown): s is LossComparisonSide =>
    !!s && typeof s === 'object' && typeof (s as LossComparisonSide).expected_loss_pct === 'number' && typeof (s as LossComparisonSide).expected_value_inr === 'number';
  return side(o.baseline) && side(o.farmsignal);
}

export function useLossComparison(): LossComparison | null {
  return useLiveQuery(
    async () => {
      try {
        const v = await db.getMeta<unknown>(LOSS_COMPARISON_META_KEY);
        return isLossComparison(v) ? v : null;
      } catch {
        return null;
      }
    },
    [],
    null,
  );
}

function Column({ side, heading, testId }: { side: LossComparisonSide; heading: string; testId: string }): JSX.Element {
  const { t } = useTranslation('batch');
  const f = useFormat();
  return (
    <div className="rounded-xl bg-gray-50 p-3" data-testid={testId}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{heading}</p>
      <p className="mt-1 text-sm font-semibold text-gray-800">{side.label}</p>
      <dl className="mt-2 space-y-1 text-sm">
        <dt className="text-gray-500">{t('loss.consumed')}</dt>
        <dd className="tabular text-2xl font-extrabold text-gray-900">{f.percent(side.expected_loss_pct / 100, { maximumFractionDigits: 1 })}</dd>
        <dt className="text-gray-500">{t('loss.value')}</dt>
        <dd className="tabular text-lg font-bold text-brand-900">{f.inr(side.expected_value_inr)}</dd>
        <dt className="text-gray-500">{t('loss.mandi')}</dt>
        <dd className="font-semibold">{side.mandi_id}</dd>
      </dl>
      <p className="mt-2 text-xs text-gray-600">{side.explanation}</p>
    </div>
  );
}

export function LossComparisonCard({ className = '' }: { className?: string }): JSX.Element | null {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const data = useLossComparison();
  if (!data) return null;
  return (
    <section className={`card border-2 border-purple-200 ${className}`} aria-label={t('loss.heading')} data-testid="loss-comparison-card">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('loss.heading')}</h2>
        <SimBadge />
      </header>
      <p className="text-sm text-gray-700">{data.title}</p>
      <p className="text-xs text-gray-500">
        {t(`crops.${data.crop}`, { defaultValue: data.crop })} · {f.kg(data.qty_kg)}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Column side={data.baseline} heading={t('loss.baseline')} testId="loss-baseline" />
        <Column side={data.farmsignal} heading={t('loss.farmsignal')} testId="loss-farmsignal" />
      </div>
      <p className="mt-3 rounded-xl bg-purple-50 px-3 py-2 text-xs text-purple-900" role="note">
        {data.honesty_note}
      </p>
    </section>
  );
}

export default LossComparisonCard;
