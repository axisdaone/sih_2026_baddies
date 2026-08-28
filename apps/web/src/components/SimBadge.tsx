import { useTranslation } from 'react-i18next';

/** Honesty constraint (PRD §6): anything simulated is labelled with this chip. */
export function SimBadge({ className = '' }: { className?: string }): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <span className={`chip bg-purple-100 text-purple-900 ${className}`} title={t('simulated')}>
      {t('simulated')}
    </span>
  );
}

export default SimBadge;
