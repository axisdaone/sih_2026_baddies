import { describe, expect, it } from 'vitest';
import i18n, { resources, SUPPORTED_LANGS } from './index';

function keyPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

/** `{{count}}` and formatted `{{count, num}}` placeholders alike. */
const PLACEHOLDER = /\{\{[^}]+\}\}/g;

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
        const placeholders = (enValue.match(PLACEHOLDER) ?? []).sort();
        expect((value.match(PLACEHOLDER) ?? []).sort(), `${lng}:${section}.${key}`).toEqual(placeholders);
      }
    }
  });

  it('renders the range-critical strings in Devanagari / Tamil script', () => {
    expect(i18n.t('status.fresh', { ns: 'batch', lng: 'hi' })).toMatch(/[ऀ-ॿ]/);
    expect(i18n.t('status.fresh', { ns: 'batch', lng: 'ta' })).toMatch(/[஀-௿]/);
    expect(i18n.t('countdown.assumed_note', { ns: 'batch', lng: 'en', temp: '30' })).toContain('30 °C');
  });

  it('translates every bundled scenario description and every backend reason code', () => {
    for (const lng of SUPPORTED_LANGS) {
      for (const id of ['cool_morning', 'hot_afternoon', 'heat_spike', 'reefer_van', 'pre_cooled', 'pharma_excursion', 'pharma_freeze']) {
        expect(i18n.t(`scenario_desc.${id}`, { ns: 'batch', lng })).not.toBe(`scenario_desc.${id}`);
      }
      expect(i18n.t('reasons.no_prices', { ns: 'batch', lng })).not.toBe('reasons.no_prices');
      expect(i18n.t('why.role_reachable', { ns: 'batch', lng })).not.toBe('why.role_reachable');
    }
  });
});

describe('cross-namespace terminology', () => {
  it.each(SUPPORTED_LANGS)('uses one set of batch_status labels across batch / fpo / pass in %s', (lng) => {
    const r = resources[lng];
    expect(r.fpo.batch_status).toEqual(r.batch.batch_status);
    expect(r.pass.batch_status).toEqual(r.batch.batch_status);
  });

  it.each(SUPPORTED_LANGS)('keeps fresh / spoiled status labels aligned across namespaces in %s', (lng) => {
    const r = resources[lng];
    expect(r.pass.status.fresh).toBe(r.batch.status.fresh);
    expect(r.pass.status.spoiled).toBe(r.batch.status.spoiled);
    expect(r.fpo.tiles.fresh).toBe(r.batch.status.fresh);
    expect(r.fpo.tiles.spoiled).toBe(r.batch.status.spoiled);
  });

  it('uses one Hindi spelling for shelf life and one word for harvest, and one Tamil term for shelf life', () => {
    const hiBatch = JSON.stringify(resources.hi.batch);
    expect(hiBatch).not.toContain('शेल्फ लाइफ़'); // batch used to differ from alerts/fpo/pass/settings
    expect(hiBatch).not.toContain('कटाई');
    const taBatch = JSON.stringify(resources.ta.batch);
    expect(taBatch).not.toMatch(/ஆயுள/); // "lifespan"; the app-wide term is சேமிப்புக் காலம்
  });
});
