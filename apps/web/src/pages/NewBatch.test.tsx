import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { db } from '../db';
import { AppStatusProvider } from '../state/appStatus';
import NewBatch from './NewBatch';

vi.mock('@/worker/client', () => ({ estimateShelfLife: vi.fn(async () => Promise.reject(new Error('mocked'))) }));
vi.mock('@/alerts', () => ({ checkAlerts: vi.fn(async () => []) }));
const playMock = vi.fn(async (_key: string) => undefined);
vi.mock('@/voice', () => ({ play: (key: string) => playMock(key) }));
const drainMock = vi.fn(async () => null);
vi.mock('@/sync', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/sync')>()), drain: () => drainMock() }));

function DetailStub(): JSX.Element {
  const { id } = useParams();
  return <p data-testid="detail-stub">{id}</p>;
}

function renderNew() {
  return render(
    <AppStatusProvider>
      <MemoryRouter initialEntries={['/new']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/new" element={<NewBatch />} />
          <Route path="/batch/:id" element={<DetailStub />} />
        </Routes>
      </MemoryRouter>
    </AppStatusProvider>,
  );
}

describe('NewBatch (offline)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await Promise.all([db.batches.clear(), db.readings.clear(), db.ops.clear(), db.meta.clear()]);
    playMock.mockClear();
    drainMock.mockClear();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  });

  it('renders one tile per crop protocol and requires a crop before saving', async () => {
    renderNew();
    expect(screen.getByTestId('crop-tile-tomato')).toBeInTheDocument();
    expect(screen.getByTestId('crop-tile-guava')).toBeInTheDocument();
    expect(screen.queryByTestId('crop-tile-pharma_2_8')).not.toBeInTheDocument();
    expect(await screen.findByText(/Location unavailable/)).toBeInTheDocument(); // jsdom has no geolocation
    fireEvent.click(screen.getByTestId('save-batch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a crop first');
    expect(await db.batches.count()).toBe(0);
  });

  it('saves a batch with a first reading entirely offline and navigates to the batch', async () => {
    renderNew();
    fireEvent.click(screen.getByTestId('crop-tile-tomato'));
    fireEvent.click(screen.getByRole('button', { name: '250 kg' }));
    fireEvent.click(screen.getByRole('radio', { name: '1 h ago' }));
    fireEvent.click(screen.getByRole('button', { name: '30 °C' }));
    fireEvent.click(screen.getByTestId('save-batch'));

    const stub = await screen.findByTestId('detail-stub');
    const batches = await db.batches.toArray();
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(stub).toHaveTextContent(batch.id);
    expect(batch).toMatchObject({ crop: 'tomato', protocol_id: 'tomato', qty_kg: 250, status: 'open', synced: false });
    // falls back to the demo origin with a note when GPS is unavailable
    expect(batch.origin_lat).toBeCloseTo(12.3, 1);
    expect(batch.notes).toMatch(/Location assumed/);
    const ageMs = Date.now() - new Date(batch.harvested_at).getTime();
    expect(ageMs).toBeGreaterThan(59 * 60_000);
    expect(ageMs).toBeLessThan(61 * 60_000);

    const readings = await db.readings.toArray();
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ batch_id: batch.id, temp_c: 30, source: 'manual' });
    expect(readings[0].geohash).toHaveLength(7);

    const ops = await db.ops.orderBy('client_seq').toArray();
    expect(ops.map((o) => o.kind)).toEqual(['batch.create', 'reading.append']);
    await waitFor(() => expect(playMock).toHaveBeenCalledWith('batch_logged'));
    expect(drainMock).toHaveBeenCalled(); // opportunistic, never awaited
  });
});
