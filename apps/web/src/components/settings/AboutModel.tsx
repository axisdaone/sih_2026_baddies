/** Short in-app explainer: range not scalar, readings tighten it, routing inputs, SIMULATED labelling. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../Button';

export function AboutModel(): JSX.Element {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  return (
    <section className="card" aria-label={t('about.title')}>
      <h2 className="text-lg font-semibold">{t('about.title')}</h2>
      <button type="button" className="mt-1 min-h-12 text-left font-semibold text-brand underline underline-offset-2" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {t('about.link')}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 text-sm text-gray-800" data-testid="about-model">
          <p>{t('about.p1')}</p>
          <p>{t('about.p2')}</p>
          <p>{t('about.p3')}</p>
          <p>{t('about.p4')}</p>
          <Button variant="secondary" className="!min-h-12" onClick={() => setOpen(false)}>
            {t('about.close')}
          </Button>
        </div>
      )}
    </section>
  );
}

export default AboutModel;
