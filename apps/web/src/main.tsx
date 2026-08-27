import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import './i18n'; // initialises i18next synchronously (bundled resources)
import './index.css';
import App from './App';
import { AppStatusProvider } from './state/appStatus';
import { showUpdateToast } from './components/UpdateToast';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

// registerType is "autoUpdate": a new SW activates and reloads on its own. We still surface an
// "update available" toast as soon as the new worker is installed so the reload is not a surprise
// (and so the flow is demoable in `npm run dev`, where devOptions.enabled is on).
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    showUpdateToast(() => void updateSW(true));
  },
  onOfflineReady() {
    console.info('[pwa] offline ready');
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateToast(() => window.location.reload());
        }
      });
    });
    window.setInterval(() => void registration.update(), UPDATE_CHECK_MS);
  },
  onRegisterError(error) {
    console.warn('[pwa] service worker registration failed', error);
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <AppStatusProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
    </AppStatusProvider>
  </StrictMode>,
);
