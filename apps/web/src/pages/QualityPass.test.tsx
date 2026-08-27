import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { db } from '@/db';
import { AppStatusProvider } from '@/state/appStatus';
import type { ShelfLifeEstimate } from '@/types';

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() }, getToken: () => null, setToken: vi.fn() }));
vi.mock('@/engine/hashchain', () => ({
  computeChain: vi.fn(async () => ({ hashes: ['a'.repeat(64), 'b'.repeat(64)], head: 'b'.repeat(64) })),
  verifyChain: vi.fn(async () => ({ valid: true, chain_head: 'b'.repeat(64), length: 2, first_bad_seq: null })),
}));
vi.mock('@/worker/client', () => ({ estimateShelfLife: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QUJD') } }));

import { api } from '@/api/client';
import { computeChain, verifyChain } from '@/engine/hashchain';
import { estimateShelfLife } from '@/worker/client';
import QualityPass from './QualityPass';

const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const HEAD = 'deadbeefcafef00d'.repeat(4);

const shelf: ShelfLifeEstimate = {
  protocol_id: 'tomato',
  model_version: 'kinetics-1.0',
  computed_at: '2026-08-27T06:30:00Z',
  status: 'fresh',
  confidence: 'high',
  consumed_fraction: 0.31,
  remaining_fraction: 0.69,
  remaining_hours: { low: 41.2, mid: 58.7, high: 79 },
  expected_end: { low: '2026-08-28T23:00:00Z', mid: '2026-08-29T17:00:00Z', high: '2026-08-30T13:00:00Z' },
  current_temp_c: 28,
  current_temp_assumed: false,
  hours_since_last_reading: 0.5,
  thermal_load_degree_hours: 214,
  alerts_crossed: [],
  breach: null,
  segments: [],
};

const serverPayload = {
  batch_id: BATCH_ID,
  crop: 'tomato',
  protocol_id: 'tomato',
  protocol_name: 'Tomato',
  qty_kg: 800,
  harvested_at: '2026-08-27T02:00:00Z',
  status: 'open',
  display_name: 'Muthu',
  readings: [
    { seq: 1, temp_c: 12, taken_at: '2026-08-27T03:00:00Z', source: 'manual', hash: '1'.repeat(64) },
    { seq: 2, temp_c: 12.5, taken_at: '2026-08-27T05:00:00Z', source: 'sim', hash: HEAD },
  ],
  shelf_life: shelf,
  chain_head: HEAD,
  chain_length: 2,
  verify_url: `/api/v1/quality-pass/${BATCH_ID}/verify`,
  simulated: true,
};

function renderPass(query = '') {
  return render(
    <AppStatusProvider>
      <MemoryRouter initialEntries={[`/pass/${BATCH_ID}${query}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/pass/:id" element={<QualityPass />} />
        </Routes>
      </MemoryRouter>
    </AppStatusProvider>,
  );
}

describe('QualityPass', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await Promise.all([db.batches.clear(), db.readings.clear(), db.meta.clear()]);
    vi.mocked(api.get).mockReset();
    vi.mocked(verifyChain).mockClear();
    vi.mocked(computeChain).mockClear();
    vi.mocked(estimateShelfLife).mockReset();
  });

  it('renders the server payload and a VERIFIED badge from the API verify endpoint', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === `/quality-pass/${BATCH_ID}`) return serverPayload;
      if (path.startsWith(`/quality-pass/${BATCH_ID}/verify?head=`)) return { valid: true, chain_head: HEAD, length: 2, first_bad_seq: null };
      throw new Error(`unexpected ${path}`);
    });
    renderPass(`?h=${HEAD.slice(0, 16)}`);

    expect(await screen.findByText('VERIFIED')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quality Pass' })).toBeInTheDocument();
    expect(screen.getByTestId('pass-source')).toHaveTextContent('Live from server');
    expect(screen.getByText('Tomato · 800 kg')).toBeInTheDocument();
    expect(screen.getByText('Shared by Muthu')).toBeInTheDocument();
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0);
    expect(screen.getByText('≈ 41–79 h (most likely 59 h)')).toBeInTheDocument();
    expect(screen.getByTestId('chain-head')).toHaveTextContent(HEAD.slice(0, 16));
    expect(screen.getByText('Checked by server')).toBeInTheDocument();
    expect(screen.getByTestId('thermal-chart')).toBeInTheDocument();
    expect(screen.getByText('2 readings')).toBeInTheDocument();
    expect(await screen.findByTestId('pass-qr')).toHaveAttribute('src', 'data:image/png;base64,QUJD');

    // Verify was called with the head from the query string, anonymously; local engine untouched.
    const verifyCall = vi.mocked(api.get).mock.calls.find(([p]) => p.includes('/verify'));
    expect(verifyCall?.[0]).toBe(`/quality-pass/${BATCH_ID}/verify?head=${HEAD.slice(0, 16)}`);
    expect(verifyCall?.[1]).toEqual({ anonymous: true });
    expect(verifyChain).not.toHaveBeenCalled();
  });

  it('shows TAMPERED with the first bad reading when the server rejects the chain', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === `/quality-pass/${BATCH_ID}`) return serverPayload;
      return { valid: false, chain_head: 'f'.repeat(64), length: 7, first_bad_seq: 4 };
    });
    renderPass();
    expect(await screen.findByText('TAMPERED')).toBeInTheDocument();
    expect(screen.getByText('Chain broken at reading 4.')).toBeInTheDocument();
    expect(screen.getByTestId('verify-badge')).toHaveAttribute('data-state', 'tampered');
  });

  it('falls back to the local Dexie copy (labelled) when the API is unreachable and verifies locally', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('offline'));
    vi.mocked(estimateShelfLife).mockResolvedValue({ ...shelf, status: 'warning', remaining_hours: { low: 10, mid: 20, high: 30 } });
    await db.batches.put({
      id: BATCH_ID,
      crop: 'guava',
      protocol_id: 'guava',
      qty_kg: 120,
      harvested_at: '2026-08-27T02:00:00Z',
      origin_lat: 12.3,
      origin_lon: 78.07,
      client_seq: 1,
      client_created_at: '2026-08-27T02:00:05Z',
      farmer_id: 'f1',
      status: 'open',
      origin_geohash: null,
      created_at: '2026-08-27T02:00:05Z',
      updated_at: '2026-08-27T02:00:05Z',
      synced: true,
    });
    await db.readings.bulkPut([
      { id: 'r1', batch_id: BATCH_ID, temp_c: 30, taken_at: '2026-08-27T03:00:00Z', source: 'manual', client_seq: 2, seq: 1, hash: 'a'.repeat(64), prev_hash: '0'.repeat(64), synced: true },
      { id: 'r2', batch_id: BATCH_ID, temp_c: 33, taken_at: '2026-08-27T05:00:00Z', source: 'manual', client_seq: 3, seq: 2, hash: 'b'.repeat(64), prev_hash: 'a'.repeat(64), synced: true },
    ]);
    renderPass();

    expect(await screen.findByText('VERIFIED')).toBeInTheDocument();
    expect(screen.getByTestId('pass-source')).toHaveTextContent('Offline copy');
    expect(screen.getByText('Guava · 120 kg')).toBeInTheDocument();
    expect(screen.getByText('≈ 10–30 h (most likely 20 h)')).toBeInTheDocument();
    expect(screen.getByText('Sell soon')).toBeInTheDocument();
    expect(screen.getByText('Checked on this device')).toBeInTheDocument();
    expect(screen.getByTestId('chain-head')).toHaveTextContent('b'.repeat(16));
    expect(estimateShelfLife).toHaveBeenCalledTimes(1);
    expect(verifyChain).toHaveBeenCalledWith(BATCH_ID, expect.arrayContaining([expect.objectContaining({ id: 'r1', seq: 1 }), expect.objectContaining({ id: 'r2', seq: 2 })]));
  });

  it('shows UNVERIFIED (unsynced) for a local batch whose readings have no server hashes yet', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('offline'));
    vi.mocked(estimateShelfLife).mockResolvedValue(shelf);
    await db.batches.put({
      id: BATCH_ID,
      crop: 'tomato',
      protocol_id: 'tomato',
      qty_kg: 50,
      harvested_at: '2026-08-27T02:00:00Z',
      origin_lat: null,
      origin_lon: null,
      client_seq: 1,
      client_created_at: '2026-08-27T02:00:05Z',
      farmer_id: 'f1',
      status: 'open',
      origin_geohash: null,
      created_at: '2026-08-27T02:00:05Z',
      updated_at: '2026-08-27T02:00:05Z',
      synced: false,
    });
    await db.readings.put({ id: 'r9', batch_id: BATCH_ID, temp_c: 30, taken_at: '2026-08-27T03:00:00Z', source: 'manual', client_seq: 2, synced: false });
    renderPass();
    expect(await screen.findByText('UNVERIFIED')).toBeInTheDocument();
    expect(screen.getByText('Readings not synced yet — hashes are assigned by the server.')).toBeInTheDocument();
    expect(computeChain).toHaveBeenCalledWith(BATCH_ID, [expect.objectContaining({ id: 'r9', seq: 1 })]);
    await waitFor(() => expect(screen.getByTestId('chain-head')).toHaveTextContent('b'.repeat(16)));
  });

  it('keeps the heading and explains when neither the server nor local data has the batch', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('offline'));
    renderPass();
    expect(await screen.findByText('No pass found for this batch.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quality Pass' })).toBeInTheDocument();
  });
});
