/** Install-to-home-screen hint; uses the captured beforeinstallprompt when the browser offers one. */
import { useTranslation } from 'react-i18next';
import Button from '../Button';
import { promptInstall, useInstallPrompt } from './installPrompt';

export function InstallHint(): JSX.Element {
  const { t } = useTranslation('settings');
  const { canPrompt, installed } = useInstallPrompt();
  return (
    <section className="card" aria-label={t('install.title')}>
      <h2 className="text-lg font-semibold">{t('install.title')}</h2>
      <p className="mt-1 text-sm text-gray-600">{t('install.desc')}</p>
      {installed ? (
        <p className="mt-2 text-sm font-semibold text-brand-900">{t('install.installed')}</p>
      ) : canPrompt ? (
        <Button className="mt-3" onClick={() => void promptInstall()} fullWidth>
          {t('install.button')}
        </Button>
      ) : (
        <p className="mt-2 text-sm text-gray-700">{t('install.manual')}</p>
      )}
    </section>
  );
}

export default InstallHint;
