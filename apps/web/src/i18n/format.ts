/**
 * Locale-aware number / time formatting (contract §9). Pure functions; no React.
 * Hindi and Tamil render native numerals (Devanagari / Tamil digits) when `nativeNumerals` is on,
 * which is the default for hi/ta (Settings toggle, persisted under localStorage 'fs.numerals').
 */
import i18n from './index';
import type { Locale } from '../types';

export interface NumberFormatOptions {
  /** Render Devanagari / Tamil digits for hi / ta. Defaults to the user's stored preference. */
  nativeNumerals?: boolean;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/** BCP-47 tags used for Intl. Indian English for lakh/crore grouping. */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
const NUMBERING_SYSTEM: Partial<Record<Locale, string>> = { hi: 'deva', ta: 'tamldec' };
/** localStorage key for the numerals preference: "native" | "latin". */
export const NUMERALS_STORAGE_KEY = 'fs.numerals';
export const IST_TIME_ZONE = 'Asia/Kolkata';

/** Stored preference; default on for hi/ta, off for en. */
export function getNativeNumeralsPreference(locale: Locale): boolean {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(NUMERALS_STORAGE_KEY) : null;
    if (stored === 'native') return true;
    if (stored === 'latin') return false;
  } catch {
    /* storage unavailable (private mode) — fall through to the default */
  }
  return locale !== 'en';
}

export function setNativeNumeralsPreference(native: boolean): void {
  try {
    localStorage.setItem(NUMERALS_STORAGE_KEY, native ? 'native' : 'latin');
  } catch {
    /* ignore */
  }
}

/** Intl locale tag with the numbering-system extension applied when native numerals are wanted. */
export function intlLocale(locale: Locale, nativeNumerals?: boolean): string {
  const base = INTL_LOCALE[locale];
  const native = nativeNumerals ?? getNativeNumeralsPreference(locale);
  const nu = NUMBERING_SYSTEM[locale];
  return native && nu ? `${base}-u-nu-${nu}` : base;
}

export function formatNumber(n: number, locale: Locale, opts: NumberFormatOptions = {}): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(intlLocale(locale, opts.nativeNumerals), {
    minimumFractionDigits: opts.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts.maximumFractionDigits ?? 1,
  }).format(n);
}

/** "58.7 h" — 1 dp under 10 h, whole hours above. Unit label comes from common.hours_short. */
export function formatHours(h: number, locale: Locale, opts: NumberFormatOptions = {}): string {
  if (!Number.isFinite(h)) return '—';
  const digits = Math.abs(h) < 10 ? 1 : 0;
  const unit = i18n.t('hours_short', { ns: 'common', lng: locale });
  return `${formatNumber(h, locale, { maximumFractionDigits: digits, ...opts })} ${unit}`;
}

/** Contract §9: shelf life is always a range — "≈ 41–79 h (most likely 59 h)". */
export function formatHoursRange(
  low: number,
  high: number,
  mid: number,
  locale: Locale,
  opts: NumberFormatOptions = {},
): string {
  const digits = Math.max(Math.abs(low), Math.abs(high)) < 10 ? 1 : 0;
  const nf = { maximumFractionDigits: digits, ...opts };
  const unit = i18n.t('hours_short', { ns: 'common', lng: locale });
  const mostLikely = i18n.t('most_likely', { ns: 'common', lng: locale });
  return `≈ ${formatNumber(low, locale, nf)}–${formatNumber(high, locale, nf)} ${unit} (${mostLikely} ${formatNumber(mid, locale, nf)} ${unit})`;
}

export interface DateTimeFormatOptions {
  nativeNumerals?: boolean;
  dateStyle?: Intl.DateTimeFormatOptions['dateStyle'];
  timeStyle?: Intl.DateTimeFormatOptions['timeStyle'];
}

/** Render an ISO UTC timestamp in IST (Asia/Kolkata), e.g. "27 Aug 2026, 12:00 pm". */
export function formatDateTimeIST(iso: string | Date, locale: Locale, opts: DateTimeFormatOptions = {}): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale, opts.nativeNumerals), {
    timeZone: IST_TIME_ZONE,
    dateStyle: opts.dateStyle ?? 'medium',
    timeStyle: opts.timeStyle ?? 'short',
  }).format(date);
}

/** Time-only in IST ("12:00 pm"). */
export function formatTimeIST(iso: string | Date, locale: Locale, opts: NumberFormatOptions = {}): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale, opts.nativeNumerals), {
    timeZone: IST_TIME_ZONE,
    timeStyle: 'short',
  }).format(date);
}

/** "₹1,23,456" — whole rupees by default (mandi values are estimates, not invoices). */
export function formatINR(amount: number, locale: Locale, opts: NumberFormatOptions = {}): string {
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(intlLocale(locale, opts.nativeNumerals), {
    style: 'currency',
    currency: 'INR',
    currencyDisplay: 'symbol',
    minimumFractionDigits: opts.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts.maximumFractionDigits ?? 0,
  }).format(amount);
}

/** "12.5 kg" using the localised unit label. */
export function formatKg(kg: number, locale: Locale, opts: NumberFormatOptions = {}): string {
  const unit = i18n.t('kg', { ns: 'common', lng: locale });
  return `${formatNumber(kg, locale, opts)} ${unit}`;
}

/** Percent from a 0..1 fraction: "69%". */
export function formatPercent(fraction: number, locale: Locale, opts: NumberFormatOptions = {}): string {
  if (!Number.isFinite(fraction)) return '—';
  return new Intl.NumberFormat(intlLocale(locale, opts.nativeNumerals), {
    style: 'percent',
    maximumFractionDigits: opts.maximumFractionDigits ?? 0,
  }).format(fraction);
}
