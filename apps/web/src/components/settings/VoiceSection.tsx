/** Voice settings: test button, mute toggle, clip availability (from the manifest) / TTS label. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../Button';
import { LANGUAGE_NAMES, currentLocale } from '../../i18n';
import { clipAvailability, loadManifest, play, setMuted, useVoiceStatus, type AudioManifest } from '../../voice';

export function VoiceSection(): JSX.Element {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation('common');
  const status = useVoiceStatus();
  const [manifest, setManifest] = useState<AudioManifest | null | undefined>(undefined);
  const locale = currentLocale();

  useEffect(() => {
    let cancelled = false;
    void loadManifest().then((m) => {
      if (!cancelled) setManifest(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const avail = manifest === undefined ? null : clipAvailability(manifest ?? null, locale);
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  return (
    <section className="card" aria-label={t('voice.title')}>
      <h2 className="text-lg font-semibold">{t('voice.title')}</h2>
      <div className="mt-2 text-sm text-gray-700" data-testid="voice-availability">
        {manifest === undefined && <p>{tc('loading')}</p>}
        {manifest === null && <p className="text-amber-800">{t('voice.manifest_missing')}</p>}
        {avail && (
          <p>
            {avail.ready > 0 ? `${t('voice.clips_ready')}: ` : ''}
            {t('voice.clips', { ready: avail.ready, total: avail.total, lang: LANGUAGE_NAMES[locale] })}
          </p>
        )}
        {avail && avail.ready < avail.total && (
          <p className={ttsSupported ? 'text-gray-600' : 'text-amber-800'}>{ttsSupported ? t('voice.tts') : t('voice.unavailable')}</p>
        )}
        {status.lastFallback && (
          <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700" data-testid="tts-fallback-label">
            {tc('tts_fallback')} · {t('voice.last_fallback')}
          </p>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-3">
        <Button variant="secondary" onClick={() => void play('welcome')} loading={status.playing} fullWidth>
          {t('voice.test')}
        </Button>
        <label className="flex min-h-14 cursor-pointer items-center justify-between gap-3">
          <span className="font-semibold">{t('voice.mute')}</span>
          <input type="checkbox" className="h-7 w-7 shrink-0 accent-brand" checked={status.muted} onChange={(e) => setMuted(e.target.checked)} aria-label={t('voice.mute')} />
        </label>
      </div>
    </section>
  );
}

export default VoiceSection;
