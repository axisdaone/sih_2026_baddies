/**
 * Byte-for-byte parity with the Python engine (services/api/app/kinetics/engine.py, authoritative).
 *
 * data/demo_scenarios/golden_estimates_py.json is written by
 * `services/api/scripts/dump_golden_estimates.py`: the full ShelfLifeEstimate JSON for every case in
 * golden_kinetics.json. This test runs the same inputs through the TypeScript `evaluate()` and asserts
 * deep equality of the whole estimate object — every key, every number, every timestamp — plus
 * equality of the serialised JSON (so key order matches too). No tolerances: both engines round with
 * the same `floor(x * 10**n + 0.5) / 10**n` rule, so equal doubles are expected.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOLS } from '../data';
import type { ReadingInput, ShelfLifeEstimate } from '../types';
import { evaluate, MODEL_VERSION } from './index';

// vite-node injects __dirname for test modules; src/engine -> repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DEMO_DIR = resolve(REPO_ROOT, 'data', 'demo_scenarios');

interface GoldenCase {
  id: string;
  protocol_id: string;
  harvested_at: string;
  now: string;
  readings: ReadingInput[];
}

interface GoldenInputs {
  model_version: string;
  cases: GoldenCase[];
}

interface DumpedCase {
  id: string;
  estimate: ShelfLifeEstimate;
}

interface GoldenEstimates {
  model_version: string;
  generated_from: string;
  cases: DumpedCase[];
}

const INPUTS = JSON.parse(readFileSync(resolve(DEMO_DIR, 'golden_kinetics.json'), 'utf8')) as GoldenInputs;
const PY = JSON.parse(readFileSync(resolve(DEMO_DIR, 'golden_estimates_py.json'), 'utf8')) as GoldenEstimates;
const INPUT_BY_ID = new Map(INPUTS.cases.map((c) => [c.id, c]));

describe('golden_estimates_py.json (Python engine output) == TypeScript evaluate()', () => {
  it('reference file matches this engine version and covers every golden case', () => {
    expect(PY.model_version).toBe(MODEL_VERSION);
    expect(PY.generated_from).toBe('golden_kinetics.json');
    expect(PY.cases.map((c) => c.id)).toEqual(INPUTS.cases.map((c) => c.id));
  });

  it.each(PY.cases.map((c) => [c.id, c] as const))('%s', (id, dumped) => {
    const input = INPUT_BY_ID.get(id);
    expect(input, `golden input ${id}`).toBeDefined();
    const protocol = PROTOCOLS[(input as GoldenCase).protocol_id];
    expect(protocol, `protocol ${(input as GoldenCase).protocol_id}`).toBeDefined();

    const { harvested_at, readings, now } = input as GoldenCase;
    const ts = evaluate(protocol, harvested_at, readings, now);

    // 1. Deep, strict equality of the whole object (undefined !== missing, null !== undefined).
    expect(ts).toStrictEqual(dumped.estimate);
    // 2. Identical serialised JSON: same keys in the same order, same number formatting.
    expect(JSON.stringify(ts)).toBe(JSON.stringify(dumped.estimate));
  });
});
