import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real page: shelf-life range + countdown, thermal timeline,
// add-reading action, recommendation card with a link to /batch/:id/why, QR / Quality Pass link.
export default function BatchDetail(): JSX.Element {
  const { t } = useTranslation('common');
  const { id } = useParams<{ id: string }>();
  return (
    <div className="page">
      <h1>{t('titles.batch')}</h1>
      <p className="mt-2 break-all font-mono text-xs text-gray-500">{id}</p>
    </div>
  );
}
