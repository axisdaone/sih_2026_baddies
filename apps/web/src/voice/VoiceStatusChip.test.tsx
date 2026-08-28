import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import manifestFile from '../../public/audio/manifest.json';
import { play, resetManifestCache, resetVoiceStatus, setMuted, type AudioManifest } from './index';
import { CHIP_LINGER_MS, VoiceStatusChip } from './VoiceStatusChip';

class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = '';
  private listeners = new Map<string, Array<() => void>>();
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  play(): Promise<void> {
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

describe('VoiceStatusChip', () => {
  /** Utterance whose end the test controls. */
  let finish: (() => void) | null = null;
  const speak = vi.fn((u: FakeUtterance) => {
    finish = () => u.onend?.();
  });

  beforeEach(async () => {
    await i18n.changeLanguage('en');
    resetManifestCache();
    localStorage.removeItem('fs.voice');
    resetVoiceStatus();
    setMuted(false);
    finish = null;
    speak.mockClear();
    FakeAudio.instances = [];
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    Object.defineProperty(window, 'speechSynthesis', { value: { speak, cancel: vi.fn() }, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows "Computer voice (TTS)" while a prompt falls back to TTS and hides it shortly after', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => manifestWith('missing') })));
    render(<VoiceStatusChip />);
    expect(screen.queryByTestId('tts-fallback-chip')).not.toBeInTheDocument();

    let done: Promise<void> | null = null;
    await act(async () => {
      done = play('batch_logged');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('tts-fallback-chip')).toHaveTextContent('Computer voice (TTS)');

    vi.useFakeTimers();
    await act(async () => {
      finish?.();
      await done;
    });
    // Still visible right after the utterance ends (linger), gone after CHIP_LINGER_MS.
    expect(screen.getByTestId('tts-fallback-chip')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(CHIP_LINGER_MS + 10);
    });
    expect(screen.queryByTestId('tts-fallback-chip')).not.toBeInTheDocument();
  });

  it('renders nothing when the clip plays or when muted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => manifestWith('ready') })));
    render(<VoiceStatusChip />);
    await act(async () => {
      await play('welcome');
    });
    expect(FakeAudio.instances).toHaveLength(1);
    expect(screen.queryByTestId('tts-fallback-chip')).not.toBeInTheDocument();

    setMuted(true);
    await act(async () => {
      await play('welcome');
    });
    expect(screen.queryByTestId('tts-fallback-chip')).not.toBeInTheDocument();
  });

  it('says when no voice is available at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    render(<VoiceStatusChip />);
    await act(async () => {
      await play('sell_now');
    });
    expect(await screen.findByTestId('tts-fallback-chip')).toHaveTextContent('Voice not available on this device');
  });
});
