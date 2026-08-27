/** Hash-chain verification badge: VERIFIED (green) / TAMPERED (red) / UNVERIFIED (grey). */
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import Button from '../Button';

export type VerifyVia = 'server' | 'local';

export type VerifyState =
  | { kind: 'checking' }
  /** headChecked=false: the chain recomputed cleanly but no QR head (?h=) was supplied to compare. */
  | { kind: 'verified'; length: number; via: VerifyVia; headChecked: boolean }
  | { kind: 'tampered'; firstBadSeq: number | null; via: VerifyVia }
  | { kind: 'unverified'; reason: 'offline' | 'unsynced' | 'no_head' | 'error' };

export interface VerifyBadgeProps {
  state: VerifyState;
  /** Full chain head (first 16 hex printed, as on the QR). */
  head: string | null;
  /** Server-reported chain length (QualityPassPayload.chain_length); readings.length for offline copies. */
  chainLength?: number | null;
  onReverify?: () => void;
  busy?: boolean;
}

const BADGE_CLASS: Record<VerifyState['kind'], string> = {
  checking: 'bg-gray-100 text-gray-700 border-gray-300',
  verified: 'bg-green-100 text-green-900 border-fresh',
  tampered: 'bg-red-100 text-red-900 border-spoiled',
  unverified: 'bg-gray-100 text-gray-700 border-gray-400',
};

export function VerifyBadge({ state, head, chainLength = null, onReverify, busy = false }: VerifyBadgeProps): JSX.Element {
  const { t } = useTranslation('pass');
  const f = useFormat();
  const label = state.kind === 'checking' ? t('verify.checking') : t(`verify.${state.kind}`);
  let detail = '';
  if (state.kind === 'verified') detail = t('verify.verified_detail', { count: state.length });
  else if (state.kind === 'tampered') detail = state.firstBadSeq !== null ? t('verify.tampered_detail', { seq: f.number(state.firstBadSeq) }) : t('verify.tampered_head');
  else if (state.kind === 'unverified') detail = state.reason === 'error' ? t('verify.unverified_offline') : t(`verify.unverified_${state.reason}`);
  const headNotChecked = state.kind === 'verified' && !state.headChecked;

  return (
    <section className="card" aria-label={t('verify.title')}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('verify.title')}</h2>
        {(state.kind === 'verified' || state.kind === 'tampered') && (
          <span className="text-xs text-gray-500">{state.via === 'server' ? t('verify.checked_server') : t('verify.checked_local')}</span>
        )}
      </header>
      <div
        className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 ${BADGE_CLASS[state.kind]}`}
        role="status"
        aria-live="polite"
        data-testid="verify-badge"
        data-state={state.kind}
      >
        <span aria-hidden="true" className="text-2xl leading-none">
          {state.kind === 'verified' ? '✓' : state.kind === 'tampered' ? '✕' : state.kind === 'checking' ? '…' : '?'}
        </span>
        <div className="min-w-0">
          <p className="text-lg font-bold tracking-wide">{label}</p>
          {detail && <p className="text-sm">{detail}</p>}
          {headNotChecked && (
            <p className="text-xs text-gray-500" data-testid="head-not-checked">
              {t('verify.head_not_checked')}
            </p>
          )}
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-gray-600">{t('verify.chain_head')}</dt>
        <dd className="break-all font-mono text-xs" data-testid="chain-head">
          {head ? head.slice(0, 16) : '—'}
          {head && head.length > 16 && <span className="text-gray-400">{head.slice(16, 24)}…</span>}
        </dd>
        {typeof chainLength === 'number' && (
          <>
            <dt className="text-gray-600">{t('verify.chain_length')}</dt>
            <dd className="tabular text-xs" data-testid="chain-length">
              {f.number(chainLength)}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-2 text-xs text-gray-500">{t('verify.not_blockchain')}</p>
      {onReverify && (
        <Button variant="secondary" className="mt-3 w-full" onClick={onReverify} loading={busy || state.kind === 'checking'}>
          {t('verify.reverify')}
        </Button>
      )}
    </section>
  );
}

export default VerifyBadge;
