/**
 * Contract §2: the bundled protocol/mandi JSON must be byte-for-byte equal (as parsed JSON) to the
 * canonical files in the repo. Run `npm run sync-data` if this fails.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANDIS, MANDIS_FILE, PROTOCOLS, PROTOCOL_IDS } from './index';

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
});
