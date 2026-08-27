/** Settings (/settings): language + numerals, voice, demo controls, device info, install hint, model explainer. */
import { useTranslation } from 'react-i18next';
import { LanguagePicker } from '@/components/settings/LanguagePicker';
import { VoiceSection } from '@/components/settings/VoiceSection';
import { DemoSection } from '@/components/settings/DemoSection';
import { DeviceInfo } from '@/components/settings/DeviceInfo';
import { InstallHint } from '@/components/settings/InstallHint';
import { AboutModel } from '@/components/settings/AboutModel';

export default function Settings(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page flex flex-col gap-4">
      <h1>{t('titles.settings')}</h1>
      <LanguagePicker />
      <VoiceSection />
      <DemoSection />
      <DeviceInfo />
      <InstallHint />
      <AboutModel />
    </div>
  );
}
