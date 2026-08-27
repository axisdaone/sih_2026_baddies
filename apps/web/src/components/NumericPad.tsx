/** Big-key numeric pad for temperatures / quantities (glove-friendly, no OS keyboard). */
import { useTranslation } from 'react-i18next';

export interface NumericPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Allow a leading minus (temperatures can be below 0 °C). */
  allowNegative?: boolean;
  allowDecimal?: boolean;
  maxLength?: number;
  className?: string;
}

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'] as const;

export function NumericPad({ value, onChange, allowNegative = false, allowDecimal = true, maxLength = 6, className = '' }: NumericPadProps): JSX.Element {
  const { t } = useTranslation('batch');
  const press = (k: string) => {
    if (k === 'back') return onChange(value.slice(0, -1));
    if (k === 'neg') {
      if (!allowNegative) return undefined;
      return onChange(value.startsWith('-') ? value.slice(1) : `-${value}`);
    }
    if (k === '.') {
      if (!allowDecimal || value.includes('.')) return undefined;
      return onChange(value === '' || value === '-' ? `${value}0.` : `${value}.`);
    }
    if (value.replace('-', '').length >= maxLength) return undefined;
    return onChange(value + k);
  };
  const keyClass = 'touch-target rounded-xl bg-gray-100 text-2xl font-bold text-gray-900 active:bg-gray-200';
  return (
    <div className={`grid grid-cols-3 gap-2 ${className}`} role="group" aria-label={t('pad.aria')}>
      {KEYS.map((k) => (
        <button key={k} type="button" className={keyClass} onClick={() => press(k)}>
          {k}
        </button>
      ))}
      <button type="button" className={keyClass} onClick={() => press(allowNegative ? 'neg' : '.')} disabled={!allowNegative && !allowDecimal} aria-label={allowNegative ? t('pad.negative') : t('pad.decimal')}>
        {allowNegative ? '±' : '.'}
      </button>
      <button type="button" className={keyClass} onClick={() => press('0')}>
        0
      </button>
      {allowNegative && allowDecimal ? (
        <button type="button" className={keyClass} onClick={() => press('.')} aria-label={t('pad.decimal')}>
          .
        </button>
      ) : (
        <button type="button" className={keyClass} onClick={() => press('back')} aria-label={t('pad.backspace')}>
          ⌫
        </button>
      )}
      {allowNegative && allowDecimal && (
        <button type="button" className={`${keyClass} col-span-3`} onClick={() => press('back')} aria-label={t('pad.backspace')}>
          ⌫
        </button>
      )}
    </div>
  );
}

export default NumericPad;
