/**
 * Bundled reference data. The JSON files are verbatim copies of the backend / repo data files
 * (refresh with `npm run sync-data`; src/data/data.test.ts fails if they drift).
 */
import type { DecayProtocol, Mandi, MandisFile } from '../types';
import tomato from './protocols/tomato.json';
import guava from './protocols/guava.json';
import pharma28 from './protocols/pharma_2_8.json';
import mandisFile from './mandis.json';

/** Protocol ids shipped in the bundle (must match scripts/sync-data.mjs). */
export const PROTOCOL_IDS = ['tomato', 'guava', 'pharma_2_8'] as const;
export type BundledProtocolId = (typeof PROTOCOL_IDS)[number];

// JSON tuples are typed as number[] by TS; the cast is safe because the files are validated by the
// backend Pydantic schema and by the copy test.
export const PROTOCOLS: Record<string, DecayProtocol> = {
  tomato: tomato as unknown as DecayProtocol,
  guava: guava as unknown as DecayProtocol,
  pharma_2_8: pharma28 as unknown as DecayProtocol,
};

/** Crop protocols only (what the NewBatch picker shows). */
export const CROP_PROTOCOLS: DecayProtocol[] = Object.values(PROTOCOLS).filter((p) => p.kind === 'crop');

export function getProtocol(id: string): DecayProtocol | undefined {
  return PROTOCOLS[id];
}

export const MANDIS_FILE: MandisFile = mandisFile as MandisFile;
export const MANDIS: Mandi[] = MANDIS_FILE.mandis;
export const MANDI_BY_ID: Record<string, Mandi> = Object.fromEntries(MANDIS.map((m) => [m.id, m]));
/** Demo origin (Palacode block, Dharmapuri) used when GPS is unavailable. */
export const DEMO_ORIGIN = MANDIS_FILE.demo_origin;
