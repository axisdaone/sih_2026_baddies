/**
 * Typed fetch wrapper for /api/v1. Bearer token from localStorage 'fs.token'; 8 s timeout;
 * throws ApiError for non-2xx, network failures and timeouts (status 0).
 *
 * Base URL: `VITE_API_BASE` (build-time env) overrides the default same-origin `/api/v1` — set it to
 * the full prefix, e.g. `https://api.example.com/api/v1`, when the PWA is hosted apart from the API.
 */

function resolveApiBase(): string {
  const override = (import.meta.env?.VITE_API_BASE as string | undefined)?.trim();
  return override ? override.replace(/\/+$/, '') : '/api/v1';
}

export const API_BASE = resolveApiBase();
export const TOKEN_KEY = 'fs.token';
export const DEFAULT_TIMEOUT_MS = 8_000;

export class ApiError extends Error {
  /** HTTP status, or 0 for network errors / timeouts. */
  readonly status: number;
  readonly path: string;
  readonly body: unknown;
  readonly isTimeout: boolean;

  constructor(message: string, opts: { status: number; path: string; body?: unknown; isTimeout?: boolean }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.path = opts.path;
    this.body = opts.body;
    this.isTimeout = opts.isTimeout ?? false;
  }

  /** True when the request never reached the server (offline, DNS, timeout). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Send without Authorization even if a token exists (public endpoints). */
  anonymous?: boolean;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** True for our API: a relative URL, one under API_BASE, or one on this page's origin. */
export function isOwnApiUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  if (/^https?:\/\//i.test(API_BASE) && url.startsWith(`${API_BASE}/`)) return true;
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return !!origin && origin !== 'null' && url.startsWith(`${origin}/`);
}

async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Propagate an external abort signal into ours.
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // The bearer token only ever goes to our own API: relative paths, or absolute URLs under API_BASE /
  // this origin. Any other absolute URL (e.g. a server-supplied pass_url) is treated as anonymous.
  const token = opts.anonymous || !isOwnApiUrl(url) ? null : getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    clearTimeout(timer);
    const message = timedOut ? `Request timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : 'Network error';
    throw new ApiError(message, { status: 0, path, isTimeout: timedOut });
  }
  clearTimeout(timer);

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'detail' in parsed ? String((parsed as { detail: unknown }).detail) : response.statusText;
    throw new ApiError(`${method} ${path} -> ${response.status} ${detail}`, { status: response.status, path, body: parsed });
  }
  return parsed as T;
}

export const api = {
  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>('GET', path, undefined, opts);
  },
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('POST', path, body ?? {}, opts);
  },
  patch<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>('PATCH', path, body, opts);
  },
  delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, undefined, opts);
  },
};

export default api;
