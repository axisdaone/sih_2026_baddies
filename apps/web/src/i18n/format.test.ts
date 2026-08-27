import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './index';
import {
  formatDateIST,
  formatDateTimeIST,
  formatDigits,
  formatHours,
  formatHoursRange,
  formatINR,
  formatNumber,
  formatPercent,
  getNativeNumeralsPreference,
  NUMERALS_STORAGE_KEY,
} from './format';

describe('format', () => {
  it('renders native numerals for hi/ta and Latin digits for en', () => {
    expect(formatNumber(1234.5, 'en', { nativeNumerals: true })).toBe('1,234.5');
    expect(formatNumber(59, 'hi', { nativeNumerals: true })).toBe('५९');
    expect(formatNumber(59, 'ta', { nativeNumerals: true })).toBe('௫௯');
    expect(formatNumber(59, 'hi', { nativeNumerals: false })).toBe('59');
  });

  it('formats hours with the localised unit', () => {
    expect(formatHours(58.7, 'en', { nativeNumerals: false })).toBe('59 h');
    expect(formatHours(6.25, 'en', { nativeNumerals: false })).toBe('6.3 h');
    expect(formatHours(58.7, 'hi', { nativeNumerals: false })).toBe('59 घं');
    expect(formatHours(58.7, 'ta', { nativeNumerals: false })).toBe('59 மணி');
  });

  it('always shows shelf life as a range (contract §9)', () => {
    expect(formatHoursRange(41.2, 79, 58.7, 'en', { nativeNumerals: false })).toBe('≈ 41–79 h (most likely 59 h)');
  });

  it('formats INR with Indian grouping and no paise', () => {
    expect(formatINR(123456, 'en', { nativeNumerals: false })).toBe('₹1,23,456');
  });

  it('renders timestamps in IST', () => {
    // 06:30 UTC = 12:00 IST
    const s = formatDateTimeIST('2026-08-27T06:30:00Z', 'en', { nativeNumerals: false });
    expect(s).toContain('12:00');
    expect(s).toMatch(/2026/);
  });

  it('renders date-only values in IST (price_reported_on) and dashes for null', () => {
    const s = formatDateIST('2026-08-25', 'en', { nativeNumerals: false });
    expect(s).toContain('25 Aug 2026');
    expect(s).not.toMatch(/:\d\d/);
    expect(formatDateIST(null, 'en')).toBe('—');
    expect(formatDateIST('', 'en')).toBe('—');
    expect(formatDateIST('garbage', 'en')).toBe('—');
    expect(formatDateIST('2026-08-25', 'ta', { nativeNumerals: true })).toMatch(/[௦-௯]/);
    // A full timestamp late in the UTC day is still the same IST calendar day.
    expect(formatDateIST('2026-08-25T20:00:00Z', 'en', { nativeNumerals: false })).toContain('26 Aug 2026');
  });

  it('transliterates raw input digit by digit (numeric pad echo)', () => {
    expect(formatDigits('-3.50', 'hi', { nativeNumerals: true })).toBe('-३.५०');
    expect(formatDigits('12.34', 'en', { nativeNumerals: false })).toBe('12.34');
    expect(formatDigits('0.', 'ta', { nativeNumerals: true })).toBe('௦.');
    expect(formatDigits('-', 'hi', { nativeNumerals: true })).toBe('-');
  });

  it('supports signDisplay for uplift percentages', () => {
    expect(formatPercent(0.23, 'en', { nativeNumerals: false, signDisplay: 'exceptZero' })).toBe('+23%');
    expect(formatPercent(-0.05, 'en', { nativeNumerals: false, signDisplay: 'exceptZero' })).toBe('-5%');
  });
});

describe('native numerals default', () => {
  beforeEach(() => localStorage.removeItem(NUMERALS_STORAGE_KEY));
  afterEach(() => localStorage.removeItem(NUMERALS_STORAGE_KEY));

  it('is on for Hindi only (Tamil digits are not in contemporary use); stored value overrides', () => {
    expect(getNativeNumeralsPreference('en')).toBe(false);
    expect(getNativeNumeralsPreference('hi')).toBe(true);
    expect(getNativeNumeralsPreference('ta')).toBe(false);
    localStorage.setItem(NUMERALS_STORAGE_KEY, 'native');
    expect(getNativeNumeralsPreference('ta')).toBe(true);
    localStorage.setItem(NUMERALS_STORAGE_KEY, 'latin');
    expect(getNativeNumeralsPreference('hi')).toBe(false);
  });
});
