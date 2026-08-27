import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real page: language picker, native numerals toggle, voice test, device/sync info.
export default function Settings(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page">
      <h1>{t('titles.settings')}</h1>
    </div>
  );
}
