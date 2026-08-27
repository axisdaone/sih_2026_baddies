/**
 * Kinetics Web Worker (module worker). Receives a KineticsRequest and posts back {id, estimate}
 * (or {id, error}). Keeps the evaluator off the main thread so the countdown stays smooth offline.
 *
 * The project tsconfig uses the DOM lib (not WebWorker) so `self` is typed as Window; the
 * Window.onmessage / postMessage(message) signatures are compatible with the worker global scope.
 */
import { evaluate } from '../engine';
import type { KineticsRequest, KineticsResponse } from './protocol';

function respond(message: KineticsResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<KineticsRequest>) => {
  const { id, protocol, harvested_at, readings, now } = event.data;
  try {
    const estimate = evaluate(protocol, harvested_at, readings, now);
    respond({ id, estimate });
  } catch (err) {
    respond({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
