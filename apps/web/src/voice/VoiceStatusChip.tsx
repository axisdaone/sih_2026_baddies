/**
 * Contract §9: when a prompt falls back to the computer voice the UI shows a small "TTS fallback"
 * label *where the prompt fires*. Mounted once in App.tsx (outside <Routes>, so it covers the
 * immediate navigate() after NewBatch saves). Shows for the duration of a TTS prompt plus a short
 * linger, or when no voice is available at all; renders nothing for idle / clip / muted.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStatus } from './index';

/** How long the chip stays after the utterance ends. */
export const CHIP_LINGER_MS = 3_000;

export function VoiceStatusChip(): JSX.Element | null {
  const { t } = useTranslation('common');
  const s = useVoiceStatus();
  const fallback = s.mode === 'tts' || s.mode === 'unavailable';
  const active = fallback && (s.playing || s.mode === 'unavailable');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      setVisible(true);
      return undefined;
    }
    if (!fallback) {
      setVisible(false);
      return undefined;
    }
    // Utterance finished: linger briefly, reset on each new prompt (lastKey in deps).
    const timer = setTimeout(() => setVisible(false), CHIP_LINGER_MS);
    return () => clearTimeout(timer);
  }, [active, fallback, s.lastKey]);

  if (!visible) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center"
      style={{ bottom: 'calc(var(--fs-nav-h) + var(--fs-safe-bottom) + 0.75rem)' }}
    >
      <span
        role="status"
        aria-live="polite"
        data-testid="tts-fallback-chip"
        className="rounded-full border border-gray-300 bg-white/95 px-3 py-1 text-xs font-semibold text-gray-700 shadow"
      >
        {s.mode === 'unavailable' ? t('voice_unavailable') : t('tts_fallback')}
      </span>
    </div>
  );
}

export default VoiceStatusChip;
