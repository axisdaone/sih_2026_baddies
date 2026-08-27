import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real page: FPO dashboard (member batches by urgency + Leaflet map of batches vs mandis).
export default function Fpo(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page">
      <h1>{t('titles.fpo')}</h1>
    </div>
  );
}
