import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real page: batch list ordered by urgency with live shelf-life countdowns.
export default function Home(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page">
      <h1>{t('titles.home')}</h1>
    </div>
  );
}
