/** Big-button language picker (native names) + native-numerals toggle. */
import { useTranslation } from 'react-i18next';
import { LANGUAGE_NAMES, SUPPORTED_LANGS, currentLocale, setLanguage } from '../../i18n';
import { setNativeNumerals, useFormat } from '../../i18n/useFormat';
import type { Locale } from '../../types';

export function LanguagePicker(): JSX.Element {
  const { t } = useTranslation('settings');
  const f = useFormat();
  const active = currentLocale();
  return (
    <section className="card" aria-label={t('language.title')}>
      <h2 className="text-lg font-semibold">{t('language.title')}</h2>
      <p className="mb-3 text-sm text-gray-600">{t('language.hint')}</p>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('language.title')}>
        {SUPPORTED_LANGS.map((lng: Locale) => (
          <button
            key={lng}
            type="button"
            role="radio"
            aria-checked={active === lng}
            lang={lng}
            onClick={() => void setLanguage(lng)}
            className={`min-h-16 rounded-xl border-2 px-2 text-lg font-bold ${
              active === lng ? 'border-brand bg-brand text-white' : 'border-gray-300 bg-white text-gray-800 hover:bg-brand-50'
            }`}
          >
            {LANGUAGE_NAMES[lng]}
          </button>
        ))}
      </div>
      <label className="mt-4 flex min-h-14 cursor-pointer items-center justify-between gap-3">
        <span>
          <span className="block font-semibold">{t('numerals.title')}</span>
          <span className="block text-sm text-gray-600">{t('numerals.desc')}</span>
          <span className="block text-sm tabular text-gray-800">{t('numerals.preview', { sample: f.number(1234.5) })}</span>
        </span>
        <input
          type="checkbox"
          className="h-7 w-7 shrink-0 accent-brand"
          checked={f.nativeNumerals}
          onChange={(e) => setNativeNumerals(e.target.checked)}
          aria-label={t('numerals.title')}
        />
      </label>
    </section>
  );
}

export default LanguagePicker;
