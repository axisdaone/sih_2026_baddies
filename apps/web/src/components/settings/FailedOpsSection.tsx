/**
 * Outbox ops the server rejected MAX_REJECT_ATTEMPTS times (contract §7 status `failed`, terminal):
 * they are no longer retried or counted in the pending badge; this lists them with the server's
 * error so the farmer can discard them. Renders nothing when there are none.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db } from '../../db';
import { discardOp, isExhausted } from '../../db/outbox';

export function FailedOpsSection(): JSX.Element | null {
  const { t } = useTranslation('settings');
  const rows = useLiveQuery(async () => (await db.ops.where('status').equals('failed').filter(isExhausted).toArray()).sort((a, b) => a.client_seq - b.client_seq), [], []);
  if (rows.length === 0) return null;
  return (
    <section className="card border-2 border-spoiled" aria-label={t('sync.failed_title')} data-testid="failed-ops">
      <h2 className="text-lg font-semibold">{t('sync.failed_title')}</h2>
      <p className="mt-1 text-sm text-gray-600">{t('sync.failed_desc')}</p>
      <ul className="mt-2 divide-y divide-gray-100">
        {rows.map((op) => (
          <li key={op.op_id} className="flex items-center gap-3 py-2" data-testid="failed-op">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm font-semibold">{op.kind}</p>
              <p className="break-words text-xs text-gray-600">{op.last_error ?? '—'}</p>
              <p className="text-xs text-gray-500">{t('sync.attempts', { count: op.attempts })}</p>
            </div>
            <button type="button" className="min-h-12 shrink-0 rounded-full border-2 border-spoiled px-3 text-sm font-semibold text-spoiled" onClick={() => void discardOp(op.op_id)}>
              {t('sync.discard')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default FailedOpsSection;
