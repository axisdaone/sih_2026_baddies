/**
 * Contract §2: the bundled protocol/mandi JSON must be byte-for-byte equal (as parsed JSON) to the
 * canonical files in the repo. Run `npm run sync-data` if this fails.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANDIS, MANDIS_FILE, PROTOCOLS, PROTOCOL_IDS } from './index';
import { SCENARIOS, SCENARIO_IDS, scenariosForProtocol } from './scenarios';

// vite-node injects __dirname for test modules; src/data -> repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

function readJson(relativeToRepoRoot: string): unknown {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativeToRepoRoot), 'utf8'));
}

describe('bundled data mirrors the canonical repo files', () => {
  it.each(PROTOCOL_IDS)('protocol %s equals services/api/app/kinetics/protocols/%s.json', (id) => {
    const original = readJson(`services/api/app/kinetics/protocols/${id}.json`);
    expect(PROTOCOLS[id]).toEqual(original);
  });

  it('mandis.json equals data/mandis.json', () => {
    const original = readJson('data/mandis.json');
    expect(MANDIS_FILE).toEqual(original);
    expect(MANDIS.length).toBeGreaterThan(0);
  });

  it('every protocol has the fields the evaluator needs', () => {
    for (const id of PROTOCOL_IDS) {
      const p = PROTOCOLS[id];
      expect(p.id).toBe(id);
      expect(['q10', 'excursion']).toContain(p.model);
      expect(p.reference_shelf_life_range_hours).toHaveLength(2);
      expect(typeof p.default_ambient_c).toBe('number');
    }
  });

  it.each(SCENARIO_IDS)('scenario %s equals data/demo_scenarios/%s.json', (id) => {
    const original = readJson(`data/demo_scenarios/${id}.json`);
    expect(SCENARIOS[id]).toEqual(original);
  });

  it('every scenario is well-formed for the SIMULATED player', () => {
    for (const id of SCENARIO_IDS) {
      const s = SCENARIOS[id];
      expect(s.id).toBe(id);
      expect(s.readings.length).toBeGreaterThan(0);
      expect(s.readings[0].offset_hours).toBe(0);
      for (let i = 1; i < s.readings.length; i += 1) {
        expect(s.readings[i].offset_hours).toBeGreaterThanOrEqual(s.readings[i - 1].offset_hours);
      }
      expect(s.suitable_protocols.every((p) => p in PROTOCOLS)).toBe(true);
    }
    expect(scenariosForProtocol('tomato').map((s) => s.id)).not.toContain('pharma_freeze');
    expect(scenariosForProtocol('pharma_2_8').length).toBeGreaterThan(0);
  });
});
