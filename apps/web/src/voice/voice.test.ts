import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import manifestFile from '../../public/audio/manifest.json';
import { VOICE_KEYS } from '../types';
import { getVoiceStatus, loadManifest, play, resetManifestCache, resetVoiceStatus, setMuted, voiceText, type AudioManifest } from './index';

type Listener = () => void;

/** Minimal HTMLAudioElement stand-in: play() resolves and fires "ended" on the next tick. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  static failPlayback = false;
  preload = '';
  private listeners = new Map<string, Listener[]>();
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  play(): Promise<void> {
    if (FakeAudio.failPlayback) return Promise.reject(new Error('NotAllowedError'));
    queueMicrotask(() => this.listeners.get('ended')?.forEach((cb) => cb()));
    return Promise.resolve();
  }
}

class FakeUtterance {
  lang = '';
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function manifestWith(status: 'ready' | 'missing'): AudioManifest {
  return { ...(manifestFile as AudioManifest), clips: (manifestFile as AudioManifest).clips.map((c) => ({ ...c, status })) };
}

function mockFetchManifest(m: AudioManifest | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (m ? { ok: true, json: async () => m } : { ok: false, json: async () => ({}) })),
  );
}

describe('voice/play', () => {
  const speak = vi.fn((u: FakeUtterance) => queueMicrotask(() => u.onend?.()));
  const cancel = vi.fn();

  beforeEach(async () => {
    await i18n.changeLanguage('en');
    resetManifestCache();
    localStorage.removeItem('fs.voice');
    resetVoiceStatus();
    setMuted(false);
    FakeAudio.instances = [];
    FakeAudio.failPlayback = false;
    speak.mockClear();
    cancel.mockClear();
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    Object.defineProperty(window, 'speechSynthesis', { value: { speak, cancel }, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to speechSynthesis (labelled) when the manifest says the clip is missing', async () => {
    mockFetchManifest(manifestWith('missing'));
    await play('welcome');
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0][0];
    expect(utterance.text).toBe(voiceText('welcome', 'en'));
    expect(utterance.text).toBe('Welcome to FarmSignal. Sell before it spoils.');
    expect(utterance.lang).toBe('en-IN');
    expect(FakeAudio.instances).toHaveLength(0);
    const status = getVoiceStatus();
    expect(status.mode).toBe('tts');
    expect(status.lastFallback).toBe(true);
    expect(status.lastKey).toBe('welcome');
    expect(status.playing).toBe(false);
  });

  it('speaks the translated sentence with the locale language tag', async () => {
    mockFetchManifest(null); // manifest unreachable => everything is "missing"
    await i18n.changeLanguage('ta');
    await play('sell_now');
    const utterance = speak.mock.calls[0][0];
    expect(utterance.lang).toBe('ta-IN');
    expect(utterance.text).toBe(i18n.t('voice.sell_now', { ns: 'alerts', lng: 'ta' }));
    expect(utterance.text).toMatch(/[஀-௿]/); // Tamil script
  });

  it('plays the clip when the manifest marks it ready and does not touch TTS', async () => {
    mockFetchManifest(manifestWith('ready'));
    await play('alert_75');
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(['/audio/en/alert_75.mp3']);
    expect(speak).not.toHaveBeenCalled();
    expect(getVoiceStatus().mode).toBe('clip');
    expect(getVoiceStatus().lastFallback).toBe(false);
  });

  it('falls back to TTS when a "ready" clip fails to play', async () => {
    mockFetchManifest(manifestWith('ready'));
    FakeAudio.failPlayback = true;
    await play('alert_25');
    expect(FakeAudio.instances).toHaveLength(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(getVoiceStatus().mode).toBe('tts');
  });

  it('is silent when muted and never rejects on unknown keys or missing APIs', async () => {
    mockFetchManifest(manifestWith('missing'));
    setMuted(true);
    await play('welcome');
    expect(speak).not.toHaveBeenCalled();
    expect(getVoiceStatus().mode).toBe('muted');
    setMuted(false);
    await expect(play('not-a-key')).resolves.toBeUndefined();
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    await expect(play('welcome')).resolves.toBeUndefined();
    expect(getVoiceStatus().mode).toBe('unavailable');
  });

  it('caches the manifest across calls', async () => {
    mockFetchManifest(manifestWith('missing'));
    await loadManifest();
    await loadManifest();
    await play('welcome');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('public/audio/manifest.json', () => {
  it('lists every (locale, key) pair exactly once with a matching path', () => {
    const m = manifestFile as AudioManifest;
    expect(m.keys).toEqual([...VOICE_KEYS]);
    expect(m.locales).toEqual(['en', 'hi', 'ta']);
    expect(m.clips).toHaveLength(21);
    const seen = new Set<string>();
    for (const clip of m.clips) {
      const id = `${clip.locale}/${clip.key}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      expect(clip.path).toBe(`/audio/${clip.locale}/${clip.key}.mp3`);
      expect(['ready', 'missing']).toContain(clip.status);
    }
  });

  it('has a fallback sentence for every key in every locale', () => {
    for (const lng of ['en', 'hi', 'ta'] as const) {
      for (const key of VOICE_KEYS) {
        const text = i18n.t(`voice.${key}`, { ns: 'alerts', lng });
        expect(text, `${lng}:${key}`).not.toBe(`voice.${key}`);
        expect(text.length).toBeGreaterThan(5);
      }
    }
  });
});
