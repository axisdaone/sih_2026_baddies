/**
 * worker/client.ts: inline fallback when `Worker` is unavailable, and the request/response,
 * timeout, error and terminate paths against a fake Worker (no real thread in jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOLS } from '../data';
import { evaluate } from '../engine';
import type { ReadingInput, ShelfLifeEstimate } from '../types';
import { estimateShelfLife, terminateKineticsWorker } from './client';
import type { KineticsRequest, KineticsResponse } from './protocol';

const TOMATO = PROTOCOLS.tomato;
const HARVEST = '2026-08-27T00:30:00Z';
const NOW = '2026-08-27T06:30:00Z';
const READINGS: ReadingInput[] = [
  { id: '00000000-0000-4000-8000-000000000001', temp_c: 30, taken_at: '2026-08-27T00:30:00Z' },
  { id: '00000000-0000-4000-8000-000000000002', temp_c: 30, taken_at: '2026-08-27T03:30:00Z' },
];

/** Stand-in for the browser Worker: records posts, lets tests reply or fail on demand. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<KineticsResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: KineticsRequest[] = [];
  terminated = false;

  constructor(
    public readonly url: URL | string,
    public readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: KineticsRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: KineticsResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<KineticsResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

afterEach(() => {
  terminateKineticsWorker();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWorker.instances = [];
});

describe('inline fallback (no Worker global)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', undefined);
  });

  it('evaluates on the calling thread and returns exactly what engine.evaluate returns', async () => {
    expect(typeof Worker).toBe('undefined');
    const viaClient = await estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW });
    expect(viaClient).toEqual(evaluate(TOMATO, HARVEST, READINGS, NOW));
    expect(viaClient.remaining_hours.mid).toBe(66);
    expect(viaClient.computed_at).toBe(NOW);
  });

  it('defaults `now` to the current time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.500Z'));
    const est = await estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS });
    expect(est.computed_at).toBe('2026-09-01T00:00:00Z');
    expect(est.status).toBe('spoiled'); // 5 days at 30 C is well past 72 h
    expect(est.hours_since_last_reading).toBe(116.5);
  });

  it('rejects (rather than throwing synchronously) on bad input', async () => {
    await expect(estimateShelfLife({ protocol: TOMATO, harvested_at: 'garbage', readings: [] })).rejects.toThrow(/harvested_at/);
  });
});

describe('worker path (fake Worker global)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
  });

  it('creates one module worker lazily, posts the request and resolves on the matching reply', async () => {
    const p1 = estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW });
    const p2 = estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: [], now: NOW });
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0];
    expect(w.options).toMatchObject({ type: 'module' });
    // vite rewrites the URL to ".../kinetics.worker.ts?worker_file&type=module".
    expect(String(w.url)).toMatch(/kinetics\.worker\.ts(\?.*)?$/);
    expect(w.posted).toHaveLength(2);
    expect(w.posted[0]).toMatchObject({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW });
    expect(w.posted[0].id).not.toBe(w.posted[1].id);

    const est1: ShelfLifeEstimate = evaluate(TOMATO, HARVEST, READINGS, NOW);
    const est2: ShelfLifeEstimate = evaluate(TOMATO, HARVEST, [], NOW);
    // Reply out of order to prove correlation by id.
    w.reply({ id: w.posted[1].id, estimate: est2 });
    w.reply({ id: 'unknown-id', estimate: est2 }); // ignored
    w.reply({ id: w.posted[0].id, estimate: est1 });
    await expect(p1).resolves.toEqual(est1);
    await expect(p2).resolves.toEqual(est2);
  });

  it('rejects when the worker replies with an error', async () => {
    const p = estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW });
    const w = FakeWorker.instances[0];
    w.reply({ id: w.posted[0].id, error: 'invalid now timestamp' });
    await expect(p).rejects.toThrow('invalid now timestamp');
  });

  it('times out a request the worker never answers', async () => {
    vi.useFakeTimers();
    const p = estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW }, { timeoutMs: 50 });
    // Attach the handler before the timer fires so the rejection is never "unhandled".
    const rejected = expect(p).rejects.toThrow('kinetics worker timeout');
    await vi.advanceTimersByTimeAsync(60);
    await rejected;
  });

  it('a worker error fails all pending requests and recreates the worker on the next call', async () => {
    const p = estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW });
    const w = FakeWorker.instances[0];
    w.fail('boom');
    await expect(p).rejects.toThrow('kinetics worker error: boom');
    expect(w.terminated).toBe(true);

    void estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW }).catch(() => undefined);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('terminateKineticsWorker rejects in-flight requests', async () => {
    const p = estimateShelfLife({ protocol: TOMATO, harvested_at: HARVEST, readings: READINGS, now: NOW });
    terminateKineticsWorker();
    await expect(p).rejects.toThrow('kinetics worker terminated');
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });
});
