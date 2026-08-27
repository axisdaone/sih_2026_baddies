/**
 * Main-thread client for the kinetics worker. One lazily-created worker, request/response matched
 * by id. Falls back to evaluating inline where Workers are unavailable (tests, very old browsers).
 */
import { evaluate } from '../engine';
import type { KineticsInput, ShelfLifeEstimate } from '../types';
import type { KineticsRequest, KineticsResponse } from './protocol';

interface Pending {
  resolve: (estimate: ShelfLifeEstimate) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
let worker: Worker | null = null;
let counter = 0;
const pending = new Map<string, Pending>();

function nextId(): string {
  counter += 1;
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${counter}`;
}

function failAll(error: Error): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(error);
    pending.delete(id);
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./kinetics.worker.ts', import.meta.url), { type: 'module', name: 'farmsignal-kinetics' });
  worker.onmessage = (event: MessageEvent<KineticsResponse>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.estimate);
  };
  worker.onerror = (event) => {
    failAll(new Error(`kinetics worker error: ${event.message}`));
    terminateKineticsWorker();
  };
  return worker;
}

/** Tear down the worker (e.g. on hot reload); it is recreated on the next call. */
export function terminateKineticsWorker(): void {
  worker?.terminate();
  worker = null;
  failAll(new Error('kinetics worker terminated'));
}

/**
 * Evaluate shelf life off the main thread. `input.now` defaults to the current time.
 * Without a Worker global (tests, very old browsers) it evaluates inline and still returns a Promise.
 */
export async function estimateShelfLife(
  input: Omit<KineticsInput, 'now'> & { now?: string },
  opts: { timeoutMs?: number } = {},
): Promise<ShelfLifeEstimate> {
  const now = input.now ?? new Date().toISOString();
  if (typeof Worker === 'undefined') {
    return evaluate(input.protocol, input.harvested_at, input.readings, now);
  }
  const id = nextId();
  const request: KineticsRequest = { id, protocol: input.protocol, harvested_at: input.harvested_at, readings: input.readings, now };
  return new Promise<ShelfLifeEstimate>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('kinetics worker timeout'));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    getWorker().postMessage(request);
  });
}
