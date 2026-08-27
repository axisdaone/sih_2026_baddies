/** Shelf-life status chip using the tailwind theme colours (fresh / warning / critical / spoiled). */
import { useTranslation } from 'react-i18next';
import type { BatchStatus, ShelfLifeStatus } from '../types';

// Literal class strings so Tailwind's content scan keeps them.
export const STATUS_BG: Record<ShelfLifeStatus, string> = {
  fresh: 'bg-fresh text-white',
  warning: 'bg-warning text-gray-950',
  critical: 'bg-critical text-white',
  spoiled: 'bg-spoiled text-white',
};
export const STATUS_TEXT: Record<ShelfLifeStatus, string> = {
  fresh: 'text-fresh',
  warning: 'text-warning',
  critical: 'text-critical',
  spoiled: 'text-spoiled',
};
export const STATUS_BAR: Record<ShelfLifeStatus, string> = {
  fresh: 'bg-fresh',
  warning: 'bg-warning',
  critical: 'bg-critical',
  spoiled: 'bg-spoiled',
};
export const STATUS_BORDER: Record<ShelfLifeStatus, string> = {
  fresh: 'border-fresh',
  warning: 'border-warning',
  critical: 'border-critical',
  spoiled: 'border-spoiled',
};

export function StatusPill({ status, className = '' }: { status: ShelfLifeStatus; className?: string }): JSX.Element {
  const { t } = useTranslation('batch');
  return (
    <span className={`chip ${STATUS_BG[status]} ${className}`} data-status={status}>
      {t(`status.${status}`)}
    </span>
  );
}

const BATCH_STATUS_CLASS: Record<BatchStatus, string> = {
  open: 'bg-brand-100 text-brand-900',
  sold: 'bg-sky-100 text-sky-900',
  spoiled: 'bg-red-100 text-red-900',
  discarded: 'bg-gray-200 text-gray-800',
};

/** Batch lifecycle chip (open / sold / spoiled / discarded). */
export function BatchStatusChip({ status, className = '' }: { status: BatchStatus; className?: string }): JSX.Element {
  const { t } = useTranslation('batch');
  return (
    <span className={`chip ${BATCH_STATUS_CLASS[status]} ${className}`} data-batch-status={status}>
      {t(`batch_status.${status}`)}
    </span>
  );
}

export default StatusPill;
