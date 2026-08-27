/** Manual temperature entry: numeric pad + quick chips; the caller persists via addReadingLocal. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';
import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { NumericPad } from './NumericPad';

export const QUICK_TEMPS_C = [12, 20, 25, 30, 35] as const;
const MIN_C = -50;
const MAX_C = 80;

export interface AddReadingSheetProps {
  open: boolean;
  onClose: () => void;
  onSave: (tempC: number) => Promise<void> | void;
}

export function parseTemp(value: string): number | null {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < MIN_C || n > MAX_C) return null;
  return n;
}

export function AddReadingSheet({ open, onClose, onSave }: AddReadingSheetProps): JSX.Element | null {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const temp = parseTemp(value);

  const save = async () => {
    if (temp === null) return;
    setSaving(true);
    try {
      await onSave(temp);
      setValue('');
      onClose();
    } catch {
      /* the caller has already explained the failure (toast); keep the sheet open with the value */
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={t('reading.add_title')}>
      <div className="mb-3 flex items-center justify-center rounded-2xl bg-gray-50 py-3">
        <output className="tabular text-5xl font-extrabold" aria-live="polite" aria-label={t('reading.temp_label')}>
          {value === '' ? '—' : f.digits(value)}
          <span className="ml-1 text-2xl text-gray-500">°C</span>
        </output>
      </div>
      <div className="mb-3 flex flex-wrap gap-2" aria-label={t('reading.quick')}>
        {QUICK_TEMPS_C.map((q) => (
          <button key={q} type="button" className={`min-h-14 rounded-full px-4 text-base font-semibold ${value === String(q) ? 'bg-brand text-white' : 'bg-brand-50 text-brand-900'}`} onClick={() => setValue(String(q))}>
            {f.number(q)} °C
          </button>
        ))}
      </div>
      <NumericPad value={value} onChange={setValue} allowNegative allowDecimal maxLength={5} />
      {value !== '' && temp === null && <p className="mt-2 text-sm text-red-700">{t('reading.invalid', { min: MIN_C, max: MAX_C })}</p>}
      <Button fullWidth className="mt-4" onClick={() => void save()} disabled={temp === null} loading={saving}>
        {t('reading.save')}
      </Button>
    </BottomSheet>
  );
}

export default AddReadingSheet;
