import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { db, META_KEYS } from '@/db';
import { AppStatusProvider } from '@/state/appStatus';
import { AlertHost } from '@/alerts/AlertHost';
import { clearToasts } from '@/alerts/toast';
import type { LossComparison } from '@/types';

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() }, getToken: vi.fn(() => null), setToken: vi.fn() }));
vi.mock('@/sync', () => ({ drain: vi.fn(async () => null), enqueue: vi.fn() }));
vi.mock('@/voice', async () => {
  const actual = await vi.importActual<typeof import('@/voice')>('@/voice');
  return { ...actual, play: vi.fn(async () => undefined), loadManifest: vi.fn(async () => null) };
});

import { api, setToken } from '@/api/client';
import { drain } from '@/sync';
import { play } from '@/voice';
import { LOSS_COMPARISON_META_KEY } from '@/components/LossComparisonCard';
import Settings from './Settings';

const lossComparison: LossComparison = {
  title: '18% vs 7%: the pitch comparison, computed live by the engine',
  crop: 'tomato',
  qty_kg: 500,
  baseline: { label: 'Status quo: wait for a trader', scenario: 'hot_afternoon', evaluate_at_offset_hours: 10, mandi_id: 'palacode', explanation: '8 h hot yard.', expected_loss_pct: 18.3, expected_value_inr: 3462 },
  farmsignal: { label: 'FarmSignal: leave at hour 4', scenario: 'cool_morning', evaluate_at_offset_hours: 4, mandi_id: 'hosur', explanation: '4 h cool.', expected_loss_pct: 6.2, expected_value_inr: 6638 },
  honesty_note: 'Both numbers are a simulation.',
};

function batchRow(id: string, farmerId: string, synced: boolean) {
  return {
    id,
    crop: 'tomato' as const,
    protocol_id: 'tomato',
    qty_kg: 100,
    harvested_at: '2026-08-27T02:00:00Z',
    origin_lat: 12.3,
    origin_lon: 78.07,
    client_seq: 1,
    client_created_at: '2026-08-27T02:00:05Z',
    farmer_id: farmerId,
    status: 'open' as const,
    origin_geohash: null,
    created_at: '2026-08-27T02:00:05Z',
    updated_at: '2026-08-27T02:00:05Z',
    synced,
  };
}

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
    await Promise.all([db.meta.clear(), db.batches.clear(), db.readings.clear(), db.ops.clear()]);
    localStorage.removeItem('fs.numerals');
    clearToasts();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.get).mockReset();
    vi.mocked(setToken).mockClear();
    vi.mocked(drain).mockClear();
    vi.mocked(drain).mockResolvedValue(null);
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

  it('loads the demo identity: drains under the old identity first, seeds, stores the token + identity, drains, and toasts (labelled simulated)', async () => {
    vi.mocked(api.post).mockResolvedValue({ farmer_id: 'farmer-demo', device_id: 'demo-device-001', token: 'jwt-demo', batch_ids: ['b1', 'b2'], created: true });
    vi.mocked(drain).mockResolvedValue({ server_now: '2026-08-27T06:30:00Z', clock_skew_seconds: 0, results: [], batches: [] });
    vi.mocked(api.get).mockResolvedValue([]);
    // An unsynced local batch (pending create) must survive; a synced batch of another farmer must go.
    await db.batches.bulkPut([batchRow('local-unsynced', '', false), batchRow('old-synced', 'farmer-old', true)]);
    await db.readings.put({ id: 'r-old', batch_id: 'old-synced', temp_c: 30, taken_at: '2026-08-27T03:00:00Z', source: 'manual', client_seq: 2, synced: true });
    renderSettings();
    fireEvent.click(screen.getByTestId('load-demo'));

    expect(await screen.findByText('Demo data loaded')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/demo/seed', {}, { anonymous: true });
    expect(setToken).toHaveBeenCalledWith('jwt-demo');
    // once under the previous identity (before the token changes), once after
    expect(drain).toHaveBeenCalledTimes(2);
    expect(vi.mocked(drain).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.post).mock.invocationCallOrder[0]);
    expect(await db.getMeta(META_KEYS.deviceId)).toBe('demo-device-001');
    expect(await db.getMeta(META_KEYS.farmerId)).toBe('farmer-demo');
    expect(await db.getMeta(META_KEYS.displayName)).toBe('Muthu');
    expect(await db.getMeta(LOSS_COMPARISON_META_KEY)).toBeUndefined(); // response had no loss_comparison
    expect(screen.getByTestId('toast-success')).toHaveTextContent('SIMULATED');
    expect(await db.batches.get('local-unsynced')).toBeDefined();
    expect(await db.batches.get('old-synced')).toBeUndefined();
    expect(await db.readings.get('r-old')).toBeUndefined();
  });

  it('stores the seed loss_comparison and renders the comparison card; keeps a name the farmer already chose', async () => {
    await db.setMeta(META_KEYS.displayName, 'Kamala');
    vi.mocked(api.post).mockResolvedValue({
      farmer_id: 'farmer-demo',
      device_id: 'demo-device-001',
      token: 'jwt-demo',
      batch_ids: [],
      created: false,
      loss_comparison: lossComparison,
    });
    vi.mocked(api.get).mockResolvedValue([]);
    renderSettings();
    fireEvent.click(screen.getByTestId('load-demo'));
    expect(await screen.findByText('Demo data loaded')).toBeInTheDocument();
    expect(await db.getMeta<LossComparison>(LOSS_COMPARISON_META_KEY)).toMatchObject({ baseline: { expected_loss_pct: 18.3 } });
    expect(await screen.findByTestId('loss-comparison-card')).toHaveTextContent('18.3%');
    expect(await db.getMeta(META_KEYS.displayName)).toBe('Kamala');
  });

  it('shows an error toast when the seed endpoint is unreachable', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('offline'));
    renderSettings();
    fireEvent.click(screen.getByTestId('load-demo'));
    expect(await screen.findByText('Could not load demo data')).toBeInTheDocument();
    expect(setToken).not.toHaveBeenCalled();
  });

  it('lets the farmer opt out of the display name: POSTs display_name "" and hides the name', async () => {
    await db.setMeta(META_KEYS.displayName, 'Muthu');
    vi.mocked(api.post).mockResolvedValue({ token: 'jwt-1', farmer_id: 'farmer-1' });
    renderSettings();
    const toggle = await screen.findByTestId('share-display-name');
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('save-display-name'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/device', expect.objectContaining({ display_name: '' }), { anonymous: true }));
    expect(await db.getMeta(META_KEYS.shareDisplayName)).toBe(false);
    expect(await db.getMeta(META_KEYS.displayNameDirty)).toBeUndefined(); // cleared after the successful POST
    await waitFor(() => expect(screen.getByText('Farmer').nextElementSibling).toHaveTextContent('—'));
  });

  it('lists exhausted rejected ops with a Discard button', async () => {
    await db.ops.put({
      op_id: 'op-dead',
      client_seq: 9,
      client_time: '2026-08-27T03:00:00Z',
      kind: 'reading.append',
      payload: { id: 'r1', batch_id: 'b1', temp_c: 30, taken_at: '2026-08-27T03:00:00Z', source: 'manual', geohash: null, client_seq: 9 },
      status: 'failed',
      created_at: '2026-08-27T03:00:00Z',
      attempts: 5,
      last_error: 'batch_not_found',
      last_attempt_at: '2026-08-27T04:00:00Z',
    });
    renderSettings();
    const row = await screen.findByTestId('failed-op');
    expect(row).toHaveTextContent('reading.append');
    expect(row).toHaveTextContent('batch_not_found');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByTestId('failed-op')).not.toBeInTheDocument());
    expect(await db.ops.get('op-dead')).toBeUndefined();
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
