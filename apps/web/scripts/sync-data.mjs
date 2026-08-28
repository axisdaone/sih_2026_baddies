#!/usr/bin/env node
/**
 * Copies the canonical protocol + mandi + demo-scenario JSON files from the backend / data directories into
 * src/data so the web bundle never diverges (contract §2: "copied verbatim"; a vitest test compares them).
 * Usage: npm run sync-data
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');

export const PROTOCOL_IDS = ['tomato', 'guava', 'pharma_2_8'];
/** Demo temperature profiles (data/demo_scenarios/README.md) replayed by the PWA's SIMULATED player. */
export const SCENARIO_IDS = [
  'cool_morning',
  'hot_afternoon',
  'heat_spike',
  'reefer_van',
  'pre_cooled',
  'pharma_excursion',
  'pharma_freeze',
];

const copies = [
  ...PROTOCOL_IDS.map((id) => [
    resolve(REPO_ROOT, 'services', 'api', 'app', 'kinetics', 'protocols', `${id}.json`),
    resolve(WEB_ROOT, 'src', 'data', 'protocols', `${id}.json`),
  ]),
  [resolve(REPO_ROOT, 'data', 'mandis.json'), resolve(WEB_ROOT, 'src', 'data', 'mandis.json')],
  ...SCENARIO_IDS.map((id) => [
    resolve(REPO_ROOT, 'data', 'demo_scenarios', `${id}.json`),
    resolve(WEB_ROOT, 'src', 'data', 'scenarios', `${id}.json`),
  ]),
];

for (const [from, to] of copies) {
  JSON.parse(readFileSync(from, 'utf8')); // fail loudly on invalid JSON before overwriting anything
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${from.replace(REPO_ROOT, '')} -> ${to.replace(WEB_ROOT, 'apps/web')}`);
}
