/**
 * Thermal timeline: inline SVG step chart (piecewise-constant, as the kinetics evaluator sees it)
 * with the protocol's ideal band shaded and hard limits dashed, plus a plain table of readings.
 * No chart library — the page must stay small and work offline.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import type { DecayProtocol, ReadingSource } from '../../types';

export interface TimelineReading {
  seq: number;
  temp_c: number;
  taken_at: string;
  source: ReadingSource;
  hash?: string;
}

export interface ThermalTimelineProps {
  readings: TimelineReading[];
  harvestedAt: string;
  protocol?: DecayProtocol;
  /** Right edge of the chart; defaults to the current time. */
  now?: string;
}

const W = 360;
const H = 200;
const PAD = { l: 38, r: 12, t: 12, b: 26 };
const SOURCE_FILL: Record<ReadingSource, string> = { manual: '#166534', sim: '#7e22ce', ble: '#1d4ed8' };

/** Ideal band for shading: pharma band_c; crops = [chilling floor, reference temp]. */
export function idealBand(protocol?: DecayProtocol): [number, number] | null {
  if (!protocol) return null;
  if (protocol.band_c) return protocol.band_c;
  const hi = protocol.reference_temp_c;
  const lo = protocol.min_effective_temp_c ?? hi - 5;
  return [Math.min(lo, hi), hi];
}

export function ThermalTimeline({ readings, harvestedAt, protocol, now }: ThermalTimelineProps): JSX.Element {
  const { t } = useTranslation('pass');
  const f = useFormat();
  const nowMs = now ? Date.parse(now) : Date.now();

  const chart = useMemo(() => {
    const sorted = [...readings].sort((a, b) => a.seq - b.seq);
    const harvestMs = Date.parse(harvestedAt);
    const times = sorted.map((r) => Date.parse(r.taken_at));
    const t0 = Math.min(harvestMs, ...times);
    const lastMs = times.length ? Math.max(...times) : harvestMs;
    const t1 = Math.max(lastMs, Math.min(nowMs, lastMs + 48 * 3600e3), t0 + 3600e3);
    const band = idealBand(protocol);
    const ambient = protocol?.default_ambient_c ?? 30;
    const temps = sorted.map((r) => r.temp_c);
    const domainVals = [...temps, ambient, ...(band ?? [])];
    const lo = Math.floor(Math.min(...domainVals) - 3);
    const hi = Math.ceil(Math.max(...domainVals) + 3);
    const x = (ms: number) => PAD.l + ((ms - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (c: number) => PAD.t + ((hi - c) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);
    // Step path: each reading holds until the next; the last holds until the right edge.
    let path = '';
    sorted.forEach((r, i) => {
      const px = x(Date.parse(r.taken_at));
      const py = y(r.temp_c);
      path += i === 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : ` H${px.toFixed(1)} V${py.toFixed(1)}`;
    });
    if (sorted.length) path += ` H${x(t1).toFixed(1)}`;
    const ambientPath = sorted.length ? `M${x(t0).toFixed(1)},${y(ambient).toFixed(1)} H${x(Date.parse(sorted[0].taken_at)).toFixed(1)}` : `M${x(t0).toFixed(1)},${y(ambient).toFixed(1)} H${x(t1).toFixed(1)}`;
    const ticks = [lo, Math.round((lo + hi) / 2), hi];
    const limits = (protocol?.hard_thresholds ?? []).filter((h) => h.value_c >= lo && h.value_c <= hi);
    return { sorted, t0, t1, band, ambient, lo, hi, x, y, path, ambientPath, ticks, limits };
  }, [readings, harvestedAt, protocol, nowMs]);

  const { sorted, t0, t1, band, lo, hi, x, y, path, ambientPath, ticks, limits, ambient } = chart;

  return (
    <section className="card" aria-label={t('timeline.title')}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('timeline.title')}</h2>
        <span className="text-sm text-gray-600">{t('timeline.readings_count', { count: sorted.length })}</span>
      </header>
      {sorted.length === 0 && <p className="mb-2 text-sm text-gray-600">{t('timeline.no_readings', { temp: f.number(ambient) })}</p>}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t('timeline.title')} data-testid="thermal-chart">
        {band && (
          <rect x={PAD.l} y={y(Math.min(band[1], hi))} width={W - PAD.l - PAD.r} height={Math.max(0, y(Math.max(band[0], lo)) - y(Math.min(band[1], hi)))} fill="#16a34a" opacity={0.14}>
            <title>{t('timeline.ideal_band')}</title>
          </rect>
        )}
        {limits.map((h) => (
          <g key={`${h.type}-${h.value_c}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(h.value_c)} y2={y(h.value_c)} stroke="#b91c1c" strokeDasharray="4 3" strokeWidth={1} />
            <text x={W - PAD.r} y={y(h.value_c) - 3} fontSize={9} textAnchor="end" fill="#b91c1c">
              {t('timeline.hard_limit')} {f.number(h.value_c)}°
            </text>
          </g>
        ))}
        {/* axes */}
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} stroke="#9ca3af" strokeWidth={1} />
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#9ca3af" strokeWidth={1} />
        {ticks.map((c) => (
          <g key={c}>
            <line x1={PAD.l - 3} x2={W - PAD.r} y1={y(c)} y2={y(c)} stroke="#e5e7eb" strokeWidth={0.5} />
            <text x={PAD.l - 6} y={y(c) + 3} fontSize={9} textAnchor="end" fill="#4b5563">
              {f.number(c)}°
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 8} fontSize={9} fill="#4b5563">
          {f.time(new Date(t0))}
        </text>
        <text x={W - PAD.r} y={H - 8} fontSize={9} textAnchor="end" fill="#4b5563">
          {f.time(new Date(t1))}
        </text>
        {/* assumed ambient before the first reading */}
        <path d={ambientPath} fill="none" stroke="#9ca3af" strokeDasharray="3 3" strokeWidth={1.5} />
        {path && <path d={path} fill="none" stroke="#166534" strokeWidth={2} strokeLinejoin="round" />}
        {sorted.map((r) => (
          <circle key={r.seq} cx={x(Date.parse(r.taken_at))} cy={y(r.temp_c)} r={3.5} fill={SOURCE_FILL[r.source] ?? '#166534'} stroke="#fff" strokeWidth={1}>
            <title>{`#${r.seq} ${f.number(r.temp_c, { maximumFractionDigits: 1 })} °C · ${f.dateTime(r.taken_at)}`}</title>
          </circle>
        ))}
      </svg>
      <p className="mt-1 text-xs text-gray-500">
        {f.dateTime(new Date(t0))} → {f.dateTime(new Date(t1))}
        {band && ` · ${t('timeline.ideal_band')} ${f.number(band[0])}–${f.number(band[1])} °C`}
      </p>
      {sorted.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="py-1 pr-2">{t('timeline.seq')}</th>
                <th className="py-1 pr-2">{t('timeline.time')}</th>
                <th className="py-1 pr-2">{t('timeline.temp')}</th>
                <th className="py-1 pr-2">{t('timeline.source')}</th>
                <th className="py-1">{t('timeline.hash')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.seq} className="border-t border-gray-100">
                  <td className="py-1 pr-2 tabular">{f.number(r.seq)}</td>
                  <td className="py-1 pr-2 tabular">{f.dateTime(r.taken_at)}</td>
                  <td className="py-1 pr-2 tabular">{f.number(r.temp_c, { maximumFractionDigits: 1 })}</td>
                  <td className="py-1 pr-2">
                    <span className={r.source === 'sim' ? 'chip bg-purple-100 text-purple-900' : ''}>{t(`source.${r.source}`)}</span>
                  </td>
                  <td className="py-1 font-mono text-xs text-gray-500">{r.hash ? r.hash.slice(0, 8) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default ThermalTimeline;
