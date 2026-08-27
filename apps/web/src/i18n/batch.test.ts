import { describe, expect, it } from 'vitest';
import i18n, { resources, SUPPORTED_LANGS } from './index';

function keyPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('batch namespace', () => {
  it('keeps hi and ta batch keys in step with en', () => {
    const en = keyPaths(resources.en.batch).sort();
    expect(en.length).toBeGreaterThan(100);
    expect(keyPaths(resources.hi.batch).sort()).toEqual(en);
    expect(keyPaths(resources.ta.batch).sort()).toEqual(en);
  });

  it.each(SUPPORTED_LANGS)('has no empty strings and keeps interpolation placeholders in %s', (lng) => {
    const en = resources.en.batch as Record<string, Record<string, string>>;
    const target = resources[lng].batch as Record<string, Record<string, string>>;
    for (const [section, entries] of Object.entries(en)) {
      for (const [key, enValue] of Object.entries(entries)) {
        const value = target[section][key];
        expect(value, `${lng}:${section}.${key}`).toBeTruthy();
        const placeholders = (enValue.match(/\{\{\w+\}\}/g) ?? []).sort();
        expect((value.match(/\{\{\w+\}\}/g) ?? []).sort(), `${lng}:${section}.${key}`).toEqual(placeholders);
      }
    }
  });

  it('renders the range-critical strings in Devanagari / Tamil script', () => {
    expect(i18n.t('status.fresh', { ns: 'batch', lng: 'hi' })).toMatch(/[ऀ-ॿ]/);
    expect(i18n.t('status.fresh', { ns: 'batch', lng: 'ta' })).toMatch(/[஀-௿]/);
    expect(i18n.t('countdown.assumed_note', { ns: 'batch', lng: 'en', temp: '30' })).toContain('30 °C');
  });
});
