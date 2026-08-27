/** Minimal bottom sheet (no portal lib): backdrop + panel above the nav, Escape closes. */
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps): JSX.Element | null {
  const { t } = useTranslation('common');
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="presentation">
      <button type="button" className="absolute inset-0 bg-black/40" aria-label={t('cancel')} onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className="relative w-full max-w-lg rounded-t-3xl bg-white p-4 pb-safe shadow-2xl" style={{ paddingBottom: 'calc(var(--fs-safe-bottom) + 1rem)' }}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="touch-target rounded-full text-2xl text-gray-500" onClick={onClose} aria-label={t('cancel')}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default BottomSheet;
