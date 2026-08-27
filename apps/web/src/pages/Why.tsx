import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real page: the recommendation explanation payload
// (price x distance x remaining shelf life per candidate mandi, rejected mandis with reasons).
export default function Why(): JSX.Element {
  const { t } = useTranslation('common');
  const { id } = useParams<{ id: string }>();
  return (
    <div className="page">
      <h1>{t('titles.why')}</h1>
      <p className="mt-2 break-all font-mono text-xs text-gray-500">{id}</p>
    </div>
  );
}
