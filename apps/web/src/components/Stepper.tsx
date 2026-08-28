/** +/- stepper with preset chips (quantity in kg). Big targets; typed input still available. */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';

export interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  presets?: number[];
  unit?: string;
  label: string;
  id?: string;
}

export function Stepper({ value, onChange, step = 10, min = 1, max = 100_000, presets = [], unit = '', label, id = 'stepper' }: StepperProps): JSX.Element {
  const { t } = useTranslation('batch');
  const f = useFormat();
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold text-gray-700">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <button type="button" className="touch-target rounded-xl bg-gray-100 text-3xl font-bold" onClick={() => onChange(clamp(value - step))} aria-label={t('stepper.decrease', { step })}>
          −
        </button>
        <div className="flex flex-1 items-center justify-center rounded-xl border-2 border-gray-200 bg-white">
          <input
            id={id}
            type="number"
            inputMode="numeric"
            className="tabular w-full bg-transparent text-center text-3xl font-extrabold outline-none"
            value={value}
            min={min}
            max={max}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(clamp(n));
            }}
          />
          {unit && <span className="pr-3 text-lg font-semibold text-gray-500">{unit}</span>}
        </div>
        <button type="button" className="touch-target rounded-xl bg-gray-100 text-3xl font-bold" onClick={() => onChange(clamp(value + step))} aria-label={t('stepper.increase', { step })}>
          +
        </button>
      </div>
      {presets.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className={`min-h-12 rounded-full px-4 text-base font-semibold ${value === p ? 'bg-brand text-white' : 'bg-brand-50 text-brand-900'}`}
              onClick={() => onChange(clamp(p))}
              aria-pressed={value === p}
            >
              {f.number(p)} {unit}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default Stepper;
