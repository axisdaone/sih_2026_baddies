import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { db, META_KEYS } from '@/db';
import { AppStatusProvider } from '@/state/appStatus';
import { AlertHost } from '@/alerts/AlertHost';
import { clearToasts } from '@/alerts/toast';

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() }, getToken: vi.fn(() => null), setToken: vi.fn() }));
vi.mock('@/sync', () => ({ drain: vi.fn(async () => null), enqueue: vi.fn() }));
vi.mock('@/voice', async () => {
  const actual = await vi.importActual<typeof import('@/voice')>('@/voice');
  return { ...actual, play: vi.fn(async () => undefined), loadManifest: vi.fn(async () => null) };
});

import { api, setToken } from '@/api/client';
import { drain } from '@/sync';
import { play } from '@/voice';
import Settings from './Settings';

function renderSettings() {
  return render(
    <AppStatusProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Settings />
        <AlertHost />
      </MemoryRouter>
    </AppStatusProvider>,
  );
}

describe('Settings', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await db.meta.clear();
    localStorage.removeItem('fs.numerals');
    clearToasts();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.get).mockReset();
    vi.mocked(setToken).mockClear();
    vi.mocked(drain).mockClear();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('switches the UI language from the big native-name buttons', async () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'हिन्दी' }));
    await waitFor(() => expect(i18n.language).toBe('hi'));
    expect(localStorage.getItem('fs.lang')).toBe('hi');
    expect(await screen.findByRole('heading', { name: 'सेटिंग्स' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'हिन्दी' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'தமிழ்' }));
    await waitFor(() => expect(i18n.language).toBe('ta'));
    expect(await screen.findByRole('heading', { name: 'அமைப்புகள்' })).toBeInTheDocument();
  });

  it('toggles native numerals and reflects it in the preview', async () => {
    await i18n.changeLanguage('hi');
    renderSettings();
    const toggle = screen.getByRole('checkbox', { name: 'देशी अंक' });
    expect(toggle).toBeChecked(); // default on for hi
    expect(screen.getByText(/उदाहरण:/)).toHaveTextContent('१,२३४.५');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/उदाहरण:/)).toHaveTextContent('1,234.5'));
    expect(localStorage.getItem('fs.numerals')).toBe('latin');
  });

  it('"Test voice" plays the welcome prompt', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(play).toHaveBeenCalledWith('welcome');
  });

  it('loads the demo identity: seeds, stores the token + identity, drains, and toasts (labelled simulated)', async () => {
    vi.mocked(api.post).mockResolvedValue({ farmer_id: 'farmer-demo', device_id: 'demo-device-001', token: 'jwt-demo', batch_ids: ['b1', 'b2'], created: true });
    vi.mocked(drain).mockResolvedValue({ server_now: '2026-08-27T06:30:00Z', clock_skew_seconds: 0, results: [], batches: [] });
    vi.mocked(api.get).mockResolvedValue([]);
    renderSettings();
    fireEvent.click(screen.getByTestId('load-demo'));

    expect(await screen.findByText('Demo data loaded')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/demo/seed', {}, { anonymous: true });
    expect(setToken).toHaveBeenCalledWith('jwt-demo');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(await db.getMeta(META_KEYS.deviceId)).toBe('demo-device-001');
    expect(await db.getMeta(META_KEYS.farmerId)).toBe('farmer-demo');
    expect(await db.getMeta(META_KEYS.displayName)).toBe('Muthu');
    expect(screen.getByTestId('toast-success')).toHaveTextContent('SIMULATED');
  });

  it('shows an error toast when the seed endpoint is unreachable', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('offline'));
    renderSettings();
    fireEvent.click(screen.getByTestId('load-demo'));
    expect(await screen.findByText('Could not load demo data')).toBeInTheDocument();
    expect(setToken).not.toHaveBeenCalled();
  });

  it('asks for confirmation before resetting local data', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Reset local data' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete all local data?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep data' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens the model explainer', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'How the shelf-life estimate works' }));
    expect(screen.getByTestId('about-model')).toHaveTextContent('It always shows a range');
  });
});
