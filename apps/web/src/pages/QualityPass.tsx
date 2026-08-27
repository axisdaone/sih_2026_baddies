import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// PHASE2: replace this stub with the real public page: batch summary, thermal timeline, freshness
// band, hash-chain verification badge (?h= chain head), QR (qrcode lib, lazy). Works from the
// server payload (GET /quality-pass/:id) or from local Dexie data when offline.
export default function QualityPass(): JSX.Element {
  const { t } = useTranslation('common');
  const { id } = useParams<{ id: string }>();
  return (
    <div>
      <h1>{t('titles.pass')}</h1>
      <p className="mt-2 break-all font-mono text-xs text-gray-500">{id}</p>
    </div>
  );
}
