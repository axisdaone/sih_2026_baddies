/**
 * Voice prompts (contract §9, PRD F9): pre-recorded clips at /audio/{locale}/{key}.mp3, listed in
 * public/audio/manifest.json; falls back to speechSynthesis with a visible "TTS fallback" label.
 *
 * play() never rejects — voice is an enhancement, not a dependency. A mute preference lives in
 * localStorage 'fs.voice' ("muted" | "on"). UI reads the last outcome through useVoiceStatus().
 */
import { useSyncExternalStore } from 'react';
import i18n, { currentLocale } from '../i18n';
import type { Locale, VoiceKey } from '../types';
import { VOICE_KEYS } from '../types';
export { VOICE_KEYS } from '../types';
export type { VoiceKey } from '../types';

export type ClipStatus = 'ready' | 'missing';

export interface AudioManifest {
  version: string;
  keys: VoiceKey[];
  locales: Locale[];
  clips: Array<{ locale: Locale; key: VoiceKey; path: string; status: ClipStatus }>;
}

export const AUDIO_MANIFEST_URL = '/audio/manifest.json';
/** localStorage key for the mute preference. */
export const VOICE_STORAGE_KEY = 'fs.voice';
/** BCP-47 tags handed to speechSynthesis. */
export const TTS_LANG: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
/** Upper bound on how long play() waits for a clip / utterance to finish. */
const PLAYBACK_TIMEOUT_MS = 15_000;

export function clipUrl(locale: Locale, key: VoiceKey): string {
  return `/audio/${locale}/${key}.mp3`;
}

export function isVoiceKey(value: unknown): value is VoiceKey {
  return typeof value === 'string' && (VOICE_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Mute preference
// ---------------------------------------------------------------------------

export function isMuted(): boolean {
  try {
    return localStorage.getItem(VOICE_STORAGE_KEY) === 'muted';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, muted ? 'muted' : 'on');
  } catch {
    /* storage unavailable */
  }
  emit({ ...state, muted });
}

// ---------------------------------------------------------------------------
// Status store (tiny external store; the Settings page and the TTS label subscribe to it)
// ---------------------------------------------------------------------------

export type VoiceMode = 'idle' | 'clip' | 'tts' | 'muted' | 'unavailable';

export interface VoiceStatus {
  /** How the most recent play() was (or is being) served. */
  mode: VoiceMode;
  lastKey: VoiceKey | null;
  /** True once any prompt had to use the computer voice — drives the "TTS fallback" label. */
  lastFallback: boolean;
  muted: boolean;
  playing: boolean;
  manifestLoaded: boolean;
}

let state: VoiceStatus = {
  mode: 'idle',
  lastKey: null,
  lastFallback: false,
  muted: isMuted(),
  playing: false,
  manifestLoaded: false,
};
const listeners = new Set<() => void>();
/** DOM event name emitted on every status change (for non-React listeners). */
export const VOICE_STATUS_EVENT = 'farmsignal:voice-status';

function emit(next: VoiceStatus): void {
  state = next;
  listeners.forEach((cb) => cb());
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent<VoiceStatus>(VOICE_STATUS_EVENT, { detail: next }));
  }
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): VoiceStatus {
  return state;
}

export function getVoiceStatus(): VoiceStatus {
  return state;
}

/** Module-level flag: has any prompt fallen back to TTS in this session? */
export function lastFallback(): boolean {
  return state.lastFallback;
}

export function useVoiceStatus(): VoiceStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Manifest (fetched once, cached in memory; null when unreachable)
// ---------------------------------------------------------------------------

let manifestPromise: Promise<AudioManifest | null> | null = null;

function isManifest(value: unknown): value is AudioManifest {
  return !!value && typeof value === 'object' && Array.isArray((value as AudioManifest).clips);
}

export function loadManifest(): Promise<AudioManifest | null> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        if (typeof fetch !== 'function') return null;
        const res = await fetch(AUDIO_MANIFEST_URL, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const json: unknown = await res.json();
        return isManifest(json) ? json : null;
      } catch {
        return null;
      } finally {
        emit({ ...state, manifestLoaded: true });
      }
    })();
  }
  return manifestPromise;
}

/** Forget the cached manifest (tests, or after dropping new clips in dev). */
export function resetManifestCache(): void {
  manifestPromise = null;
  emit({ ...state, manifestLoaded: false });
}

/** Clear the session status (including the sticky TTS-fallback flag). Tests / dev tooling. */
export function resetVoiceStatus(): void {
  emit({ mode: 'idle', lastKey: null, lastFallback: false, muted: isMuted(), playing: false, manifestLoaded: false });
}

export function clipStatus(manifest: AudioManifest | null, locale: Locale, key: VoiceKey): ClipStatus {
  const entry = manifest?.clips.find((c) => c.locale === locale && c.key === key);
  return entry?.status === 'ready' ? 'ready' : 'missing';
}

export interface ClipAvailability {
  ready: number;
  total: number;
  missing: VoiceKey[];
}

/** How many of the expected clips exist for a locale (Settings shows "3 of 7 recorded"). */
export function clipAvailability(manifest: AudioManifest | null, locale: Locale): ClipAvailability {
  const missing = VOICE_KEYS.filter((k) => clipStatus(manifest, locale, k) !== 'ready');
  return { ready: VOICE_KEYS.length - missing.length, total: VOICE_KEYS.length, missing: [...missing] };
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** Resolve when `p` settles or after the timeout (a stuck clip must not wedge the caller); failures propagate. */
function withTimeout(p: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, PLAYBACK_TIMEOUT_MS);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Play a pre-recorded clip; rejects on load/playback failure so the caller can fall back. */
function playClip(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof Audio === 'undefined') {
      reject(new Error('Audio unavailable'));
      return;
    }
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error(`clip failed: ${url}`)), { once: true });
    const started = audio.play();
    if (started && typeof started.catch === 'function') started.catch(reject);
  });
}

/** Speak `text` with the Web Speech API; rejects when unsupported. */
function speak(text: string, lang: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      reject(new Error('speechSynthesis unavailable'));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.95;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve(); // spoken partially or blocked — still not an app error
    try {
      synth.cancel(); // do not queue behind an older prompt
      synth.speak(utterance);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('speak failed'));
    }
  });
}

/** Translated sentence for a key (alerts:voice.<key>); falls back to the key itself. */
export function voiceText(key: VoiceKey, locale: Locale = currentLocale()): string {
  const text = i18n.t(`voice.${key}`, { ns: 'alerts', lng: locale, defaultValue: '' });
  return text || key.replace(/_/g, ' ');
}

/**
 * Play the prompt for `key` in the current UI language. Resolves when playback ends (or right away
 * when muted / unavailable). Never rejects.
 */
export async function play(key: VoiceKey | string): Promise<void> {
  if (!isVoiceKey(key)) return;
  const locale = currentLocale();
  if (isMuted()) {
    emit({ ...state, mode: 'muted', lastKey: key, muted: true, playing: false });
    return;
  }
  const manifest = await loadManifest();
  if (clipStatus(manifest, locale, key) === 'ready') {
    emit({ ...state, mode: 'clip', lastKey: key, playing: true });
    try {
      await withTimeout(playClip(clipUrl(locale, key)));
      emit({ ...state, playing: false });
      return;
    } catch {
      /* clip listed but not playable (404, autoplay policy) — use the computer voice */
    }
  }
  try {
    emit({ ...state, mode: 'tts', lastKey: key, lastFallback: true, playing: true });
    await withTimeout(speak(voiceText(key, locale), TTS_LANG[locale]));
    emit({ ...state, playing: false });
  } catch {
    emit({ ...state, mode: 'unavailable', lastKey: key, playing: false });
  }
}

export default play;
