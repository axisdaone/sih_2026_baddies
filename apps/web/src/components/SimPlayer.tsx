/**
 * SIMULATED telemetry player (PRD F2 demo mode): replays a bundled scenario as `source: "sim"`
 * readings at taken_at = harvested_at + offset. Only offsets that are already in the past can be
 * played (the engine drops readings after `now`), which the UI explains. Always labelled SIMULATED.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scenariosForProtocol, type Scenario } from '../data/scenarios';
import type { BatchRow, ReadingRow } from '../db';
import { addReadingLocal } from '../db/repo';
import { useFormat } from '../i18n/useFormat';
import { addHours, hoursBetween } from '../lib/time';
import { nowIso } from '../sync/clock';
import { Button } from './Button';
import { SimBadge } from './SimBadge';

export interface SimPlayerProps {
  batch: BatchRow;
  readings: ReadingRow[];
  disabled?: boolean;
}

export interface SimStep {
  offset_hours: number;
  temp_c: number;
  taken_at: string;
  state: 'played' | 'ready' | 'future';
}

/** Which scenario steps are already appended, playable now, or still in the future. */
export function planSteps(scenario: Scenario, batch: Pick<BatchRow, 'harvested_at'>, readings: ReadingRow[], now: string = nowIso()): SimStep[] {
  const hoursSince = hoursBetween(batch.harvested_at, now);
  const simTimes = new Set(readings.filter((r) => r.source === 'sim').map((r) => new Date(r.taken_at).getTime()));
  return scenario.readings.map((s) => {
    const taken_at = addHours(batch.harvested_at, s.offset_hours);
    const played = simTimes.has(new Date(taken_at).getTime());
    return { offset_hours: s.offset_hours, temp_c: s.temp_c, taken_at, state: played ? 'played' : s.offset_hours <= hoursSince ? 'ready' : 'future' };
  });
}

export function SimPlayer({ batch, readings, disabled = false }: SimPlayerProps): JSX.Element | null {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const scenarios = useMemo(() => scenariosForProtocol(batch.protocol_id), [batch.protocol_id]);
  const [scenarioId, setScenarioId] = useState<string>(scenarios[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const scenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0];
  const steps = useMemo(() => (scenario ? planSteps(scenario, batch, readings) : []), [scenario, batch, readings]);
  if (!scenario) return null;

  const ready = steps.filter((s) => s.state === 'ready');
  const hoursSince = Math.max(0, hoursBetween(batch.harvested_at, nowIso()));

  const playSteps = async (toPlay: SimStep[]) => {
    if (toPlay.length === 0) return;
    setBusy(true);
    try {
      for (const s of toPlay) await addReadingLocal(batch.id, s.temp_c, 'sim', batch.origin_geohash, s.taken_at);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card border-2 border-purple-200" aria-label={t('sim.title')} data-testid="sim-player">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('sim.title')}</h2>
        <SimBadge />
      </header>
      <p className="mb-3 text-sm text-gray-600">{t('sim.intro')}</p>

      <label htmlFor="sim-scenario" className="mb-1 block text-sm font-semibold text-gray-700">
        {t('sim.scenario')}
      </label>
      <select id="sim-scenario" className="mb-2 min-h-12 w-full rounded-xl border-2 border-gray-200 bg-white px-3 text-base" value={scenario.id} onChange={(e) => setScenarioId(e.target.value)} disabled={disabled || busy}>
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {t(`scenarios.${s.id}`, { defaultValue: s.name })}
          </option>
        ))}
      </select>
      {/* Translated narrative; a scenario added to the bundle without a translation shows its English JSON text. */}
      <p className="mb-3 text-xs text-gray-500">{t(`scenario_desc.${scenario.id}`, { defaultValue: scenario.description })}</p>

      <ol className="mb-3 flex flex-wrap gap-1.5" aria-label={t('sim.steps')}>
        {steps.map((s) => (
          <li
            key={s.offset_hours}
            className={`tabular rounded-lg px-2 py-1 text-xs font-semibold ${
              s.state === 'played' ? 'bg-purple-600 text-white' : s.state === 'ready' ? 'bg-purple-100 text-purple-900' : 'bg-gray-100 text-gray-400 line-through'
            }`}
            title={s.state === 'future' ? t('sim.future_step') : f.dateTime(s.taken_at)}
          >
            +{f.number(s.offset_hours)} {t('common:hours_short')} · {f.number(s.temp_c)} °C
          </li>
        ))}
      </ol>

      <p className="mb-3 rounded-xl bg-purple-50 px-3 py-2 text-xs text-purple-900" role="note">
        {t('sim.only_past', { hours: f.hours(hoursSince) })}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => void playSteps(ready.slice(0, 1))} disabled={disabled || busy || ready.length === 0} loading={busy}>
          {t('sim.play_next')}
        </Button>
        <Button variant="secondary" onClick={() => void playSteps(ready)} disabled={disabled || busy || ready.length === 0}>
          {t('sim.play_all', { count: ready.length })}
        </Button>
      </div>
    </section>
  );
}

export default SimPlayer;
