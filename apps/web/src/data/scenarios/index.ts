/**
 * Bundled demo temperature profiles (verbatim copies of data/demo_scenarios/<id>.json, refreshed by
 * `npm run sync-data`). Replayed locally by the SIMULATED telemetry player (components/SimPlayer).
 */
import coolMorning from './cool_morning.json';
import hotAfternoon from './hot_afternoon.json';
import heatSpike from './heat_spike.json';
import reeferVan from './reefer_van.json';
import preCooled from './pre_cooled.json';
import pharmaExcursion from './pharma_excursion.json';
import pharmaFreeze from './pharma_freeze.json';

export interface ScenarioReading {
  /** Hours after harvested_at (may be fractional). */
  offset_hours: number;
  temp_c: number;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  suitable_protocols: string[];
  /** Sorted by offset_hours; first is always offset 0. */
  readings: ScenarioReading[];
  expected_story: string;
}

/** Scenario ids shipped in the bundle (must match scripts/sync-data.mjs SCENARIO_IDS). */
export const SCENARIO_IDS = [
  'cool_morning',
  'hot_afternoon',
  'heat_spike',
  'reefer_van',
  'pre_cooled',
  'pharma_excursion',
  'pharma_freeze',
] as const;
export type BundledScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIOS: Record<string, Scenario> = {
  cool_morning: coolMorning as Scenario,
  hot_afternoon: hotAfternoon as Scenario,
  heat_spike: heatSpike as Scenario,
  reefer_van: reeferVan as Scenario,
  pre_cooled: preCooled as Scenario,
  pharma_excursion: pharmaExcursion as Scenario,
  pharma_freeze: pharmaFreeze as Scenario,
};

export const SCENARIO_LIST: Scenario[] = SCENARIO_IDS.map((id) => SCENARIOS[id]);

/** Scenarios that make physical sense for a protocol (e.g. no freeze profile for tomatoes). */
export function scenariosForProtocol(protocolId: string): Scenario[] {
  return SCENARIO_LIST.filter((s) => s.suitable_protocols.includes(protocolId));
}

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS[id];
}
