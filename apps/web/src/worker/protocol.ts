/** Message shapes exchanged between worker/client.ts and worker/kinetics.worker.ts. */
import type { KineticsInput, ShelfLifeEstimate } from '../types';

export interface KineticsRequest extends KineticsInput {
  /** Correlation id chosen by the client. */
  id: string;
}

export type KineticsResponse =
  | { id: string; estimate: ShelfLifeEstimate; error?: undefined }
  | { id: string; estimate?: undefined; error: string };
