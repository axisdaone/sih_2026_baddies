import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import i18n, { NAMESPACES, SUPPORTED_LANGS, resources } from './i18n';
import App from './App';
import { AppStatusProvider } from './state/appStatus';

function keyPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('i18n', () => {
  it('is initialised with every namespace for every locale', () => {
    expect(i18n.isInitialized).toBe(true);
    for (const lng of SUPPORTED_LANGS) {
      for (const ns of NAMESPACES) {
        expect(i18n.hasResourceBundle(lng, ns)).toBe(true);
      }
    }
  });

  it.each(SUPPORTED_LANGS)('resolves common.app_name in %s', (lng) => {
    const value = i18n.t('app_name', { ns: 'common', lng });
    expect(value).toBeTruthy();
    expect(value).not.toBe('app_name');
    expect(value).toBe(resources[lng].common.app_name);
  });

  it('keeps hi and ta common keys in step with en', () => {
    const en = keyPaths(resources.en.common).sort();
    expect(keyPaths(resources.hi.common).sort()).toEqual(en);
    expect(keyPaths(resources.ta.common).sort()).toEqual(en);
  });

  it('pluralises pending_changes', () => {
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'en', count: 1 })).toBe('1 pending change');
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'en', count: 3 })).toBe('3 pending changes');
  });

  it('renders {{count, num}} placeholders in the numerals preference (plural selection unchanged)', () => {
    localStorage.removeItem('fs.numerals');
    // Hindi defaults to Devanagari digits; Tamil defaults to Latin (see i18n/format defaultNativeNumerals).
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'hi', count: 3 })).toBe('३ बदलाव बाकी');
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'ta', count: 3 })).toBe('3 மாற்றங்கள் நிலுவையில்');
    localStorage.setItem('fs.numerals', 'native');
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'ta', count: 3 })).toBe('௩ மாற்றங்கள் நிலுவையில்');
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'ta', count: 1 })).toBe('௧ மாற்றம் நிலுவையில்');
    localStorage.setItem('fs.numerals', 'latin');
    expect(i18n.t('pending_changes', { ns: 'common', lng: 'hi', count: 3 })).toBe('3 बदलाव बाकी');
    expect(i18n.t('timeline.readings_count', { ns: 'pass', lng: 'hi', count: 1234 })).toBe('1,234 रीडिंग');
    localStorage.removeItem('fs.numerals');
  });
});

function renderAt(path: string) {
  return render(
    <AppStatusProvider>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>
    </AppStatusProvider>,
  );
}

describe('App shell', () => {
  it('renders Home at / with the bottom nav', async () => {
    await i18n.changeLanguage('en');
    renderAt('/');
    // Lazy page: the first import transforms the module, so give it explicit headroom.
    expect(await screen.findByRole('heading', { name: 'My batches' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getAllByText('FarmSignal').length).toBeGreaterThan(0);
  });

  it('renders the public Quality Pass page without the bottom nav', async () => {
    await i18n.changeLanguage('en');
    renderAt('/pass/123e4567-e89b-42d3-a456-426614174000');
    expect(await screen.findByRole('heading', { name: 'Quality Pass' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });
});
