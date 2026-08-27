/**
 * Voice prompts (contract §9): pre-recorded clips at /audio/{locale}/{key}.mp3, listed in
 * public/audio/manifest.json; falls back to speechSynthesis with a visible "TTS fallback" label.
 */
import { currentLocale } from '../i18n';
import type { Locale, VoiceKey } from '../types';
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

export function clipUrl(locale: Locale, key: VoiceKey): string {
  return `/audio/${locale}/${key}.mp3`;
}

/**
 * Play the clip for `key` in the current UI language. Resolves when playback ends (or immediately
 * if audio is unavailable); never rejects — voice is an enhancement, not a dependency.
 * PHASE2: implemented by the voice agent (HTMLAudio + manifest check + speechSynthesis fallback).
 */
export async function play(key: VoiceKey | string): Promise<void> {
  void clipUrl(currentLocale(), key as VoiceKey);
}
