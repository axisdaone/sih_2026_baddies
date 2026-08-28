import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function NotFound(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page text-center">
      <h1>{t('titles.not_found')}</h1>
      <Link to="/" className="btn-secondary mt-6">
        {t('go_home')}
      </Link>
    </div>
  );
}
