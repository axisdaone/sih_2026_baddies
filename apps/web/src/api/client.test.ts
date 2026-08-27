import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, isOwnApiUrl, setToken, TOKEN_KEY } from './client';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function headersOf(call: number): Record<string, string> {
  return (fetchMock.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;
}

describe('api/client bearer token scope', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    setToken('secret-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(TOKEN_KEY);
  });

  it('classifies relative, same-origin and third-party URLs', () => {
    expect(isOwnApiUrl('/api/v1/sync')).toBe(true);
    expect(isOwnApiUrl(`${window.location.origin}/api/v1/batches`)).toBe(true);
    expect(isOwnApiUrl('https://evil.example/api/v1/batches')).toBe(false);
  });

  it('attaches Authorization to our API but never to a third-party absolute URL', async () => {
    await api.get('/batches');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/batches');
    expect(headersOf(0).Authorization).toBe('Bearer secret-token');

    // e.g. a server-supplied pass_url whose PUBLIC_BASE_URL points elsewhere
    await api.get('https://evil.example/pass/123');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://evil.example/pass/123');
    expect(headersOf(1).Authorization).toBeUndefined();

    await api.get(`${window.location.origin}/api/v1/quality-pass/123`);
    expect(headersOf(2).Authorization).toBe('Bearer secret-token');
  });

  it('honours anonymous: true regardless of the URL', async () => {
    await api.get('/quality-pass/123', { anonymous: true });
    expect(headersOf(0).Authorization).toBeUndefined();
  });
});
