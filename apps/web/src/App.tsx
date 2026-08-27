/**
 * Route table (contract §9). Every page is code-split with React.lazy; Leaflet / QR are only
 * imported inside their pages so they never reach the critical path.
 */
import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Layout from './components/Layout';
import PublicLayout from './components/PublicLayout';
import { UpdateToastHost } from './components/UpdateToast';

const Home = lazy(() => import('./pages/Home'));
const NewBatch = lazy(() => import('./pages/NewBatch'));
const BatchDetail = lazy(() => import('./pages/BatchDetail'));
const Why = lazy(() => import('./pages/Why'));
const QualityPass = lazy(() => import('./pages/QualityPass'));
const Fpo = lazy(() => import('./pages/Fpo'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));

export const ROUTES = {
  home: '/',
  newBatch: '/new',
  batch: (id: string) => `/batch/${id}`,
  why: (id: string) => `/batch/${id}/why`,
  pass: (id: string) => `/pass/${id}`,
  fpo: '/fpo',
  settings: '/settings',
} as const;

function PageFallback(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div className="page flex items-center justify-center py-16 text-gray-500" role="status" aria-live="polite">
      <span className="mr-3 h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-hidden="true" />
      {t('loading')}
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/new" element={<NewBatch />} />
            <Route path="/batch/:id" element={<BatchDetail />} />
            <Route path="/batch/:id/why" element={<Why />} />
            <Route path="/fpo" element={<Fpo />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/index.html" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          {/* Public page: no bottom nav, no sync chrome. */}
          <Route element={<PublicLayout />}>
            <Route path="/pass/:id" element={<QualityPass />} />
          </Route>
        </Routes>
      </Suspense>
      <UpdateToastHost />
    </>
  );
}
