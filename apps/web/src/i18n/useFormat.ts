/**
 * React hook returning formatters bound to the current UI language and numerals preference.
 * Usage: const f = useFormat(); f.hours(58.7) -> "59 h"; f.inr(12345) -> "₹12,345".
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { currentLocale } from './index';
import {
  formatDateIST,
  formatDateTimeIST,
  formatDigits,
  formatHours,
  formatHoursRange,
  formatINR,
  formatKg,
  formatNumber,
  formatPercent,
  formatTimeIST,
  getNativeNumeralsPreference,
  setNativeNumeralsPreference,
  type NumberFormatOptions,
  type DateTimeFormatOptions,
} from './format';
import type { Locale } from '../types';

// Tiny external store so a Settings toggle re-renders every formatter consumer.
const listeners = new Set<() => void>();
let version = 0;
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): number {
  return version;
}

/**
 * Update the numerals preference and notify all useFormat() consumers. Components that only use
 * `t()` with `{{count, num}}` placeholders are refreshed too by re-emitting the current language
 * (react-i18next re-renders on `languageChanged`).
 */
export function setNativeNumerals(native: boolean): void {
  setNativeNumeralsPreference(native);
  version += 1;
  listeners.forEach((cb) => cb());
  if (i18n.language) i18n.emit('languageChanged', i18n.language);
}

export interface Formatters {
  locale: Locale;
  nativeNumerals: boolean;
  number: (n: number, opts?: NumberFormatOptions) => string;
  /** Digit-by-digit transliteration of a raw input string (numeric pad echo / key caps). */
  digits: (s: string) => string;
  hours: (h: number, opts?: NumberFormatOptions) => string;
  hoursRange: (low: number, high: number, mid: number, opts?: NumberFormatOptions) => string;
  dateTime: (iso: string | Date, opts?: DateTimeFormatOptions) => string;
  /** Date only in IST ("25 Aug 2026"); "—" for null. */
  date: (iso: string | Date | null | undefined, opts?: DateTimeFormatOptions) => string;
  time: (iso: string | Date, opts?: NumberFormatOptions) => string;
  inr: (amount: number, opts?: NumberFormatOptions) => string;
  kg: (kg: number, opts?: NumberFormatOptions) => string;
  percent: (fraction: number, opts?: NumberFormatOptions) => string;
}

export function useFormat(): Formatters {
  // Re-render on language change (react-i18next) and on numerals toggle (store above).
  useTranslation();
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const locale = currentLocale();
  const nativeNumerals = getNativeNumeralsPreference(locale);
  // Callers may override nativeNumerals per call; otherwise the stored preference applies.
  const withDefault = useCallback(
    <T extends { nativeNumerals?: boolean }>(opts?: T): T & { nativeNumerals: boolean } => ({
      ...(opts ?? ({} as T)),
      nativeNumerals: opts?.nativeNumerals ?? nativeNumerals,
    }),
    [nativeNumerals],
  );
  return useMemo<Formatters>(
    () => ({
      locale,
      nativeNumerals,
      number: (n, opts) => formatNumber(n, locale, withDefault(opts)),
      digits: (s) => formatDigits(s, locale, withDefault()),
      hours: (h, opts) => formatHours(h, locale, withDefault(opts)),
      hoursRange: (low, high, mid, opts) => formatHoursRange(low, high, mid, locale, withDefault(opts)),
      dateTime: (iso, opts) => formatDateTimeIST(iso, locale, withDefault(opts)),
      date: (iso, opts) => formatDateIST(iso, locale, withDefault(opts)),
      time: (iso, opts) => formatTimeIST(iso, locale, withDefault(opts)),
      inr: (amount, opts) => formatINR(amount, locale, withDefault(opts)),
      kg: (kg, opts) => formatKg(kg, locale, withDefault(opts)),
      percent: (fraction, opts) => formatPercent(fraction, locale, withDefault(opts)),
    }),
    [locale, nativeNumerals, withDefault],
  );
}
