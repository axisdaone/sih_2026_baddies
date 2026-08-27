/**
 * Locale-aware number / time formatting (contract §9). Pure functions; no React.
 * Hindi renders Devanagari digits when `nativeNumerals` is on (the default for hi; Tamil digits ௦–௯
 * are not in contemporary use in Tamil Nadu, so the default for ta is off — see
 * getNativeNumeralsPreference). Persisted under localStorage 'fs.numerals' via the Settings toggle.
 *
 * i18next strings use the `num` formatter for numeric placeholders (`{{count, num}}`) so plural
 * selection keeps the raw number while the rendered digits follow the same preference; see
 * registerNumeralFormatter().
 */
import i18n from './index';
import type { i18n as I18n } from 'i18next';
import type { Locale } from '../types';

export interface NumberFormatOptions {
  /** Render Devanagari / Tamil digits for hi / ta. Defaults to the user's stored preference. */
  nativeNumerals?: boolean;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  /** Intl signDisplay ("exceptZero" renders "+23%"). */
  signDisplay?: 'auto' | 'always' | 'exceptZero' | 'never';
}

/** BCP-47 tags used for Intl. Indian English for lakh/crore grouping. */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
const NUMBERING_SYSTEM: Partial<Record<Locale, string>> = { hi: 'deva', ta: 'tamldec' };
/** localStorage key for the numerals preference: "native" | "latin". */
export const NUMERALS_STORAGE_KEY = 'fs.numerals';
export const IST_TIME_ZONE = 'Asia/Kolkata';
const SUPPORTED: readonly Locale[] = ['en', 'hi', 'ta'];

/** Default when nothing is stored: on for Hindi (Devanagari digits are readable), off for en and ta. */
export function defaultNativeNumerals(locale: Locale): boolean {
  return locale === 'hi';
}

/** Stored preference, else the per-locale default (see defaultNativeNumerals). */
export function getNativeNumeralsPreference(locale: Locale): boolean {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(NUMERALS_STORAGE_KEY) : null;
    if (stored === 'native') return true;
    if (stored === 'latin') return false;
  } catch {
    /* storage unavailable (private mode) — fall through to the default */
  }
  return defaultNativeNumerals(locale);
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
    ...(opts.signDisplay ? { signDisplay: opts.signDisplay } : {}),
  }).format(n);
}

/**
 * Transliterate the digits of a raw input string one by one ("-3.50" → "-३.५०") so intermediate
 * pad states ('-', '3.', '0.', '12.34') round-trip exactly; the value itself stays Latin for parsing.
 */
export function formatDigits(s: string, locale: Locale, opts: NumberFormatOptions = {}): string {
  return s.replace(/\d/g, (d) => formatNumber(Number(d), locale, { ...opts, maximumFractionDigits: 0 }));
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

/**
 * Date-only in IST ("25 Aug 2026"); accepts 'YYYY-MM-DD' (parsed as UTC midnight → the same IST
 * date) or a full ISO timestamp. null / empty / unparsable → "—".
 */
export function formatDateIST(iso: string | Date | null | undefined, locale: Locale, opts: DateTimeFormatOptions = {}): string {
  if (iso == null || iso === '') return '—';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale, opts.nativeNumerals), {
    timeZone: IST_TIME_ZONE,
    dateStyle: opts.dateStyle ?? 'medium',
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
    ...(opts.signDisplay ? { signDisplay: opts.signDisplay } : {}),
  }).format(fraction);
}

/**
 * Register the `num` interpolation formatter (`{{count, num}}`) so numeric placeholders in the
 * catalogues follow the numerals preference. Whole numbers only — interpolated counts are integers.
 * Reads the preference on every call (i18next's `add` is uncached), so a Settings toggle applies
 * to the next render.
 */
export function registerNumeralFormatter(instance: I18n): void {
  instance.services?.formatter?.add('num', (value: unknown, lng?: string) => {
    const base = (lng ?? 'en').split('-')[0];
    const locale: Locale = (SUPPORTED as readonly string[]).includes(base) ? (base as Locale) : 'en';
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? formatNumber(n, locale, { maximumFractionDigits: 0 }) : String(value ?? '');
  });
}
