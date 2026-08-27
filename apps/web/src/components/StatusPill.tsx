/**
 * Shelf-life status chip (fresh / warning / critical / spoiled) — the single source of the status
 * colour tables for every surface (batch cards, countdown, public pass, FPO list + map).
 *
 * Two looks, one component:
 *   - `variant="solid"` (default, `StatusPill`): solid theme colour, labels from the `batch` namespace
 *     ("Fresh / Warning / Critical / Spoiled") — farmer-facing screens.
 *   - `variant="soft"` (`StatusChip`): tinted background, labels from the `pass` namespace
 *     ("Fresh / Sell soon / Sell now / Spoiled") — public Quality Pass and FPO dashboard.
 * `StatusChip` is kept as a named export so both import styles keep working.
 */
import { useTranslation } from 'react-i18next';
import type { BatchStatus, ShelfLifeStatus } from '../types';

// Literal class strings so Tailwind's content scan keeps them.
export const STATUS_BG: Record<ShelfLifeStatus, string> = {
  fresh: 'bg-fresh text-white',
  warning: 'bg-warning text-gray-950',
  critical: 'bg-critical text-white',
  spoiled: 'bg-spoiled text-white',
};
// Coloured text on white: amber-500 (#f59e0b) is only 2.15:1, so warning text uses amber-700 (5.02:1).
export const STATUS_TEXT: Record<ShelfLifeStatus, string> = {
  fresh: 'text-fresh',
  warning: 'text-amber-700',
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

/** Hex values of the tailwind theme colours (for Leaflet markers / inline SVG). */
export const STATUS_HEX: Record<ShelfLifeStatus, string> = {
  fresh: '#15803d',
  warning: '#f59e0b',
  critical: '#c2410c',
  spoiled: '#b91c1c',
};

/** Soft (tinted) palette used by the public pass and the FPO dashboard. */
export const STATUS_CLASS: Record<ShelfLifeStatus, { chip: string; bar: string; text: string; border: string }> = {
  fresh: { chip: 'bg-green-100 text-green-900', bar: STATUS_BAR.fresh, text: STATUS_TEXT.fresh, border: STATUS_BORDER.fresh },
  warning: { chip: 'bg-amber-100 text-amber-900', bar: STATUS_BAR.warning, text: STATUS_TEXT.warning, border: STATUS_BORDER.warning },
  critical: { chip: 'bg-orange-100 text-orange-900', bar: STATUS_BAR.critical, text: STATUS_TEXT.critical, border: STATUS_BORDER.critical },
  spoiled: { chip: 'bg-red-100 text-red-900', bar: STATUS_BAR.spoiled, text: STATUS_TEXT.spoiled, border: STATUS_BORDER.spoiled },
};

/** Urgency order for sorting (lower = more urgent). */
export const STATUS_RANK: Record<ShelfLifeStatus, number> = { critical: 0, warning: 1, fresh: 2, spoiled: 3 };

export type StatusPillVariant = 'solid' | 'soft';
export type StatusPillNamespace = 'batch' | 'pass';

export interface StatusPillProps {
  status: ShelfLifeStatus;
  className?: string;
  /** solid = theme colour fill (default); soft = tinted background. */
  variant?: StatusPillVariant;
  /** Label source; defaults to `batch` for solid and `pass` for soft. */
  ns?: StatusPillNamespace;
}

export function StatusPill({ status, className = '', variant = 'solid', ns }: StatusPillProps): JSX.Element {
  const namespace: StatusPillNamespace = ns ?? (variant === 'solid' ? 'batch' : 'pass');
  const { t } = useTranslation(namespace);
  const colour = variant === 'solid' ? STATUS_BG[status] : STATUS_CLASS[status].chip;
  return (
    <span className={`chip ${colour} ${className}`} data-status={status} data-variant={variant}>
      {t(`status.${status}`)}
    </span>
  );
}

/** Soft chip with `pass` labels ("Sell soon" / "Sell now") — alias kept for existing imports. */
export function StatusChip(props: Omit<StatusPillProps, 'variant'>): JSX.Element {
  return <StatusPill variant="soft" {...props} />;
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
