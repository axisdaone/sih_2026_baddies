/**
 * i18next setup. All locale JSON is imported statically so translations work fully offline
 * (no lazy HTTP backend). Namespaces: common, batch, pass, fpo, alerts, settings.
 *
 * Adding a key: edit src/i18n/locales/{en,hi,ta}/<ns>.json (always add `en` first — it is the
 * fallback), then use `const { t } = useTranslation('<ns>')` and `t('key')`, or `t('ns:key')`.
 * Plurals: `key_one` / `key_other` (i18next JSON v4) with `t('key', { count })`.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import enBatch from './locales/en/batch.json';
import enPass from './locales/en/pass.json';
import enFpo from './locales/en/fpo.json';
import enAlerts from './locales/en/alerts.json';
import enSettings from './locales/en/settings.json';
import hiCommon from './locales/hi/common.json';
import hiBatch from './locales/hi/batch.json';
import hiPass from './locales/hi/pass.json';
import hiFpo from './locales/hi/fpo.json';
import hiAlerts from './locales/hi/alerts.json';
import hiSettings from './locales/hi/settings.json';
import taCommon from './locales/ta/common.json';
import taBatch from './locales/ta/batch.json';
import taPass from './locales/ta/pass.json';
import taFpo from './locales/ta/fpo.json';
import taAlerts from './locales/ta/alerts.json';
import taSettings from './locales/ta/settings.json';

import type { Locale } from '../types';
export type { Locale } from '../types';

export const SUPPORTED_LANGS: readonly Locale[] = ['en', 'hi', 'ta'] as const;
export const DEFAULT_LANG: Locale = 'en';
export const NAMESPACES = ['common', 'batch', 'pass', 'fpo', 'alerts', 'settings'] as const;
export type Namespace = (typeof NAMESPACES)[number];
export const DEFAULT_NS: Namespace = 'common';
/** localStorage key the language detector reads/writes. */
export const LANG_STORAGE_KEY = 'fs.lang';

export const resources = {
  en: { common: enCommon, batch: enBatch, pass: enPass, fpo: enFpo, alerts: enAlerts, settings: enSettings },
  hi: { common: hiCommon, batch: hiBatch, pass: hiPass, fpo: hiFpo, alerts: hiAlerts, settings: hiSettings },
  ta: { common: taCommon, batch: taBatch, pass: taPass, fpo: taFpo, alerts: taAlerts, settings: taSettings },
} as const;

/** Native-script display names for the language picker. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
  ta: 'தமிழ்',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LANGS as readonly string[]).includes(value);
}

/** Current UI locale, always one of SUPPORTED_LANGS. */
export function currentLocale(): Locale {
  const lng = (i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANG).split('-')[0];
  return isLocale(lng) ? lng : DEFAULT_LANG;
}

/** Switch language (persisted to localStorage by the detector) and update <html lang>. */
export async function setLanguage(lng: Locale): Promise<void> {
  await i18n.changeLanguage(lng);
}

if (!i18n.isInitialized) {
  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: DEFAULT_LANG,
      supportedLngs: [...SUPPORTED_LANGS],
      nonExplicitSupportedLngs: true,
      load: 'languageOnly',
      ns: [...NAMESPACES],
      defaultNS: DEFAULT_NS,
      returnNull: false,
      returnEmptyString: false,
      interpolation: { escapeValue: false }, // React already escapes
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        lookupLocalStorage: LANG_STORAGE_KEY,
        caches: ['localStorage'],
      },
      // Resources are bundled, so init can be synchronous (no flash of untranslated keys).
      initAsync: false,
    });

  i18n.on('languageChanged', (lng) => {
    if (typeof document !== 'undefined') document.documentElement.lang = lng;
  });
}

export default i18n;
