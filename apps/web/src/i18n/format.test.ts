import { describe, expect, it } from 'vitest';
import './index';
import { formatDateTimeIST, formatHours, formatHoursRange, formatINR, formatNumber } from './format';

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
});
