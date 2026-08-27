/** Shelf-life status colours (tailwind.config: fresh / warning / critical / spoiled) + chip. */
import { useTranslation } from 'react-i18next';
import type { ShelfLifeStatus } from '../../types';

export const STATUS_HEX: Record<ShelfLifeStatus, string> = {
  fresh: '#16a34a',
  warning: '#f59e0b',
  critical: '#ea580c',
  spoiled: '#b91c1c',
};

export const STATUS_CLASS: Record<ShelfLifeStatus, { chip: string; bar: string; text: string; border: string }> = {
  fresh: { chip: 'bg-green-100 text-green-900', bar: 'bg-fresh', text: 'text-fresh', border: 'border-fresh' },
  warning: { chip: 'bg-amber-100 text-amber-900', bar: 'bg-warning', text: 'text-amber-700', border: 'border-warning' },
  critical: { chip: 'bg-orange-100 text-orange-900', bar: 'bg-critical', text: 'text-critical', border: 'border-critical' },
  spoiled: { chip: 'bg-red-100 text-red-900', bar: 'bg-spoiled', text: 'text-spoiled', border: 'border-spoiled' },
};

/** Urgency order for sorting (lower = more urgent). */
export const STATUS_RANK: Record<ShelfLifeStatus, number> = { critical: 0, warning: 1, fresh: 2, spoiled: 3 };

export function StatusChip({ status, className = '' }: { status: ShelfLifeStatus; className?: string }): JSX.Element {
  const { t } = useTranslation('pass');
  return (
    <span className={`chip ${STATUS_CLASS[status].chip} ${className}`} data-status={status}>
      {t(`status.${status}`)}
    </span>
  );
}

export default StatusChip;
