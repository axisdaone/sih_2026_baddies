/**
 * F1 — log a harvest in ≤ 30 s, fully offline: crop tiles, qty stepper, harvest-time quick picks,
 * non-blocking GPS (falls back to DEMO_ORIGIN with a note), optional first reading, Save.
 * Nothing here awaits the network; the outbox syncs later.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { CropPicker } from '../components/CropPicker';
import { NumericPad } from '../components/NumericPad';
import { Stepper } from '../components/Stepper';
import { parseTemp, QUICK_TEMPS_C } from '../components/AddReadingSheet';
import { CROP_PROTOCOLS, DEMO_ORIGIN } from '../data';
import { addReadingLocal, createBatchLocal } from '../db/repo';
import { useGeolocation } from '../hooks/useGeolocation';
import { useFormat } from '../i18n/useFormat';
import { encodeGeohash } from '../lib/geohash';
import { fromDatetimeLocalIST, hoursAgo, thisMorningIST, toDatetimeLocalIST } from '../lib/time';
import { drain } from '../sync';
import { nowDate } from '../sync/clock';
import type { Crop } from '../types';
import { play } from '../voice';

type HarvestPick = 'now' | '1h' | 'morning' | 'custom';
const QTY_PRESETS = [50, 100, 250, 500];

export default function NewBatch(): JSX.Element {
  const { t } = useTranslation(['batch', 'common']);
  const f = useFormat();
  const navigate = useNavigate();
  const geo = useGeolocation();

  const [crop, setCrop] = useState<Crop | null>(null);
  const [qty, setQty] = useState(100);
  const [pick, setPick] = useState<HarvestPick>('now');
  const [customIso, setCustomIso] = useState<string>(() => nowDate().toISOString());
  const [temp, setTemp] = useState('');
  const [showPad, setShowPad] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const harvestedAt = (): string => {
    const now = nowDate();
    if (pick === 'now') return now.toISOString();
    if (pick === '1h') return hoursAgo(now, 1);
    if (pick === 'morning') return thisMorningIST(now);
    return customIso;
  };
  const tempValue = temp === '' ? null : parseTemp(temp);
  const usingFallback = geo.status !== 'ok' && geo.status !== 'locating';

  const save = async () => {
    if (!crop) {
      setError(t('batch:new.select_crop_first'));
      return;
    }
    if (temp !== '' && tempValue === null) {
      setError(t('batch:reading.invalid', { min: -50, max: 80 }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const origin = geo.fix ?? { lat: DEMO_ORIGIN.lat, lon: DEMO_ORIGIN.lon };
      const trimmedNotes = notes.trim();
      const noteParts = [trimmedNotes, geo.fix ? '' : t('batch:new.origin_note', { label: DEMO_ORIGIN.label })].filter(Boolean);
      const batch = await createBatchLocal({
        crop,
        qty_kg: qty,
        harvested_at: harvestedAt(),
        origin_lat: origin.lat,
        origin_lon: origin.lon,
        notes: noteParts.length ? noteParts.join(' · ') : null,
      });
      if (tempValue !== null) await addReadingLocal(batch.id, tempValue, 'manual', encodeGeohash(origin.lat, origin.lon));
      void play('batch_logged');
      void drain(); // opportunistic; never awaited
      navigate(`/batch/${batch.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error_generic'));
      setSaving(false);
    }
  };

  const pickClass = (p: HarvestPick) => `min-h-12 rounded-full px-4 text-base font-semibold ${pick === p ? 'bg-brand text-white' : 'bg-brand-50 text-brand-900'}`;

  return (
    <form
      className="page space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1>{t('common:titles.new')}</h1>

      <section aria-labelledby="crop-label">
        <p id="crop-label" className="mb-2 text-sm font-semibold text-gray-700">
          1 · {t('batch:new.crop')}
        </p>
        <CropPicker protocols={CROP_PROTOCOLS} value={crop} onChange={setCrop} />
      </section>

      <section>
        <Stepper id="qty" label={`2 · ${t('batch:new.qty')}`} value={qty} onChange={setQty} step={10} min={1} max={50_000} presets={QTY_PRESETS} unit={t('common:kg')} />
      </section>

      <section>
        <p className="mb-2 text-sm font-semibold text-gray-700">3 · {t('batch:new.harvest_time')}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('batch:new.harvest_time')}>
          <button type="button" role="radio" aria-checked={pick === 'now'} className={pickClass('now')} onClick={() => setPick('now')}>
            {t('batch:new.quick_now')}
          </button>
          <button type="button" role="radio" aria-checked={pick === '1h'} className={pickClass('1h')} onClick={() => setPick('1h')}>
            {t('batch:new.quick_1h')}
          </button>
          <button type="button" role="radio" aria-checked={pick === 'morning'} className={pickClass('morning')} onClick={() => setPick('morning')}>
            {t('batch:new.quick_morning')}
          </button>
          <button type="button" role="radio" aria-checked={pick === 'custom'} className={pickClass('custom')} onClick={() => setPick('custom')}>
            {t('batch:new.custom_time')}
          </button>
        </div>
        {pick === 'custom' && (
          <input
            type="datetime-local"
            aria-label={t('batch:new.custom_time')}
            className="mt-2 min-h-12 w-full rounded-xl border-2 border-gray-200 px-3 text-base"
            value={toDatetimeLocalIST(customIso)}
            max={toDatetimeLocalIST(nowDate().toISOString())}
            onChange={(e) => {
              const iso = fromDatetimeLocalIST(e.target.value);
              if (iso) setCustomIso(iso);
            }}
          />
        )}
        <p className="mt-2 text-sm text-gray-600" data-testid="harvest-preview">
          {f.dateTime(harvestedAt())} IST
        </p>
      </section>

      <section>
        <p className="mb-1 text-sm font-semibold text-gray-700">4 · {t('batch:new.location')}</p>
        <div className="flex items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm" role="status" aria-live="polite">
          {geo.status === 'locating' && <span>{t('batch:new.locating')}</span>}
          {geo.status === 'ok' && geo.fix && (
            <span className="tabular">
              {t('batch:new.location_ok', { lat: f.number(geo.fix.lat, { maximumFractionDigits: 4 }), lon: f.number(geo.fix.lon, { maximumFractionDigits: 4 }) })}
            </span>
          )}
          {usingFallback && (
            <span>
              <strong>{t('batch:new.location_unavailable')}</strong> — {t('batch:new.location_fallback', { label: DEMO_ORIGIN.label })}
            </span>
          )}
          {geo.status !== 'locating' && (
            <button type="button" className="min-h-10 shrink-0 rounded-full bg-white px-3 font-semibold text-brand" onClick={geo.retry}>
              {t('batch:new.retry_gps')}
            </button>
          )}
        </div>
      </section>

      <section>
        <p className="mb-1 text-sm font-semibold text-gray-700">5 · {t('batch:new.first_reading')}</p>
        <p className="mb-2 text-xs text-gray-500">{t('batch:new.first_reading_hint')}</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_TEMPS_C.map((q) => (
            <button key={q} type="button" className={`min-h-12 rounded-full px-4 text-base font-semibold ${temp === String(q) ? 'bg-brand text-white' : 'bg-brand-50 text-brand-900'}`} onClick={() => setTemp(String(q))}>
              {q} °C
            </button>
          ))}
          <button type="button" className="min-h-12 rounded-full bg-gray-100 px-4 text-base font-semibold text-gray-800" onClick={() => setShowPad((s) => !s)} aria-expanded={showPad}>
            {temp === '' ? t('batch:new.other_temp') : `${temp} °C`}
          </button>
          {temp !== '' && (
            <button type="button" className="min-h-12 rounded-full px-3 text-sm font-semibold text-gray-500 underline" onClick={() => setTemp('')}>
              {t('batch:new.skip_reading')}
            </button>
          )}
        </div>
        {showPad && <NumericPad className="mt-2" value={temp} onChange={setTemp} allowNegative allowDecimal maxLength={5} />}
      </section>

      <section>
        <label htmlFor="notes" className="mb-1 block text-sm font-semibold text-gray-700">
          {t('batch:new.notes')}
        </label>
        <input id="notes" type="text" className="min-h-12 w-full rounded-xl border-2 border-gray-200 px-3 text-base" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </section>

      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" fullWidth className="text-xl" loading={saving} disabled={saving} data-testid="save-batch">
        {t('batch:new.save')}
      </Button>
    </form>
  );
}
