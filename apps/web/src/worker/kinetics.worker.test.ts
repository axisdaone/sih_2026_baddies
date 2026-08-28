/**
 * worker/kinetics.worker.ts: importing the module registers `self.onmessage`; a request must be
 * answered with {id, estimate} and a bad request with {id, error}. In jsdom `self` is the window,
 * so postMessage is spied on rather than crossing a real thread boundary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOLS } from '../data';
import { evaluate } from '../engine';
import type { KineticsRequest, KineticsResponse } from './protocol';

const TOMATO = PROTOCOLS.tomato;
const posted: KineticsResponse[] = [];
let postSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  postSpy = vi.spyOn(self, 'postMessage').mockImplementation((message: unknown) => {
    posted.push(message as KineticsResponse);
  });
  await import('./kinetics.worker');
});

afterAll(() => {
  postSpy.mockRestore();
  self.onmessage = null;
});

function dispatch(request: KineticsRequest): KineticsResponse {
  posted.length = 0;
  expect(self.onmessage).toBeTypeOf('function');
  self.onmessage?.call(self, new MessageEvent<KineticsRequest>('message', { data: request }));
  expect(posted).toHaveLength(1);
  return posted[0];
}

describe('kinetics worker', () => {
  const base: KineticsRequest = {
    id: 'req-1',
    protocol: TOMATO,
    harvested_at: '2026-08-27T00:30:00Z',
    readings: [{ id: '00000000-0000-4000-8000-000000000001', temp_c: 28, taken_at: '2026-08-27T00:30:00Z' }],
    now: '2026-08-27T10:30:00Z',
  };

  it('posts back {id, estimate} identical to engine.evaluate', () => {
    const res = dispatch(base);
    expect(res.id).toBe('req-1');
    expect(res.error).toBeUndefined();
    expect(res.estimate).toEqual(evaluate(TOMATO, base.harvested_at, base.readings, base.now));
    expect(res.estimate?.remaining_hours.mid).toBe(72.7);
  });

  it('posts back {id, error} when evaluation throws', () => {
    const res = dispatch({ ...base, id: 'req-2', now: 'not-a-date' });
    expect(res.id).toBe('req-2');
    expect(res.estimate).toBeUndefined();
    expect(res.error).toMatch(/now/);
  });
});
