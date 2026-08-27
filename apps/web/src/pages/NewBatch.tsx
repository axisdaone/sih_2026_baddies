import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real page: 30-second batch logging form (crop picker with images, qty, harvest time, GPS).
export default function NewBatch(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page">
      <h1>{t('titles.new')}</h1>
    </div>
  );
}
