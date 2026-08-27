import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { db } from '../db';
import { addReadingLocal, createBatchLocal } from '../db/repo';
import { AppStatusProvider } from '../state/appStatus';
import type { ShelfLifeEstimate } from '../types';
import Home from './Home';

const estimate: ShelfLifeEstimate = {
  protocol_id: 'tomato',
  model_version: 'kinetics-1.0',
  computed_at: '2026-08-27T06:00:00Z',
  status: 'warning',
  confidence: 'medium',
  consumed_fraction: 0.6,
  remaining_fraction: 0.4,
  remaining_hours: { low: 41.2, mid: 58.7, high: 79 },
  expected_end: { low: '2026-08-28T23:12:00Z', mid: '2026-08-29T16:42:00Z', high: '2026-08-30T13:00:00Z' },
  current_temp_c: 28,
  current_temp_assumed: false,
  hours_since_last_reading: 0.5,
  thermal_load_degree_hours: 214,
  alerts_crossed: [75, 50],
  breach: null,
  segments: [],
};

const estimateMock = vi.fn(async (_input: unknown) => estimate);
vi.mock('@/worker/client', () => ({ estimateShelfLife: (input: unknown) => estimateMock(input) }));
const checkAlertsMock = vi.fn(async (_id: string, _est: unknown) => [] as never[]);
vi.mock('@/alerts', () => ({ checkAlerts: (id: string, est: unknown) => checkAlertsMock(id, est) }));

function renderHome() {
  return render(
    <AppStatusProvider>
      <MemoryRouter initialEntries={['/']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Home />
      </MemoryRouter>
    </AppStatusProvider>,
  );
}

describe('Home', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await Promise.all([db.batches.clear(), db.readings.clear(), db.ops.clear(), db.meta.clear()]);
    estimateMock.mockClear();
    checkAlertsMock.mockClear();
  });

  it('shows the empty state with a Log harvest button and the demo hint', async () => {
    renderHome();
    expect(await screen.findByTestId('home-empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Log harvest/ })).toHaveAttribute('href', '/new');
    expect(screen.getByRole('link', { name: /demo data/ })).toHaveAttribute('href', '/settings');
  });

  it('renders a batch card with the shelf-life range, status pill and SIMULATED chip', async () => {
    const batch = await createBatchLocal({ crop: 'tomato', qty_kg: 500, harvested_at: '2026-08-27T01:00:00Z', origin_lat: 12.3, origin_lon: 78.07 });
    await addReadingLocal(batch.id, 33, 'sim', null, '2026-08-27T02:00:00Z');
    renderHome();

    const range = await screen.findByTestId('card-range');
    expect(range).toHaveTextContent('≈ 41–79 h (most likely 59 h)');
    const card = screen.getByTestId('batch-card');
    expect(card).toHaveAttribute('href', `/batch/${batch.id}`);
    expect(card).toHaveTextContent('Tomato');
    expect(card).toHaveTextContent('500 kg');
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText('SIMULATED')).toBeInTheDocument();
    expect(screen.getByLabelText('Not yet synced')).toBeInTheDocument();
    expect(screen.queryByTestId('home-empty')).not.toBeInTheDocument();

    // the estimate was computed with the bundled protocol and the batch's readings
    expect(estimateMock).toHaveBeenCalled();
    const arg = estimateMock.mock.calls[0][0] as { protocol: { id: string }; readings: unknown[]; now: string };
    expect(arg.protocol.id).toBe('tomato');
    expect(arg.readings).toHaveLength(1);
    expect(checkAlertsMock).toHaveBeenCalledWith(batch.id, estimate);
    expect(screen.queryByTestId('card-assumed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('loss-comparison-card')).not.toBeInTheDocument();
  });

  it('flags a card whose range assumes the ambient temperature (no reading yet)', async () => {
    estimateMock.mockResolvedValueOnce({ ...estimate, current_temp_assumed: true, current_temp_c: 30, hours_since_last_reading: null, confidence: 'low' });
    await createBatchLocal({ crop: 'tomato', qty_kg: 100, harvested_at: '2026-08-27T01:00:00Z', origin_lat: 12.3, origin_lon: 78.07 });
    renderHome();
    expect(await screen.findByTestId('card-assumed')).toHaveTextContent('Temp. assumed');
  });

  it('renders the demo loss comparison card (labelled SIMULATED) once the seed meta exists', async () => {
    await db.setMeta('loss_comparison', {
      title: '18% vs 7%',
      crop: 'tomato',
      qty_kg: 500,
      baseline: { label: 'Status quo', scenario: 'hot_afternoon', evaluate_at_offset_hours: 10, mandi_id: 'palacode', explanation: 'yard', expected_loss_pct: 18.3, expected_value_inr: 3462 },
      farmsignal: { label: 'FarmSignal', scenario: 'cool_morning', evaluate_at_offset_hours: 4, mandi_id: 'hosur', explanation: 'cool', expected_loss_pct: 6.2, expected_value_inr: 6638 },
      honesty_note: 'A simulation, not a field measurement.',
    });
    renderHome();
    const card = await screen.findByTestId('loss-comparison-card');
    expect(card).toHaveTextContent('18.3%');
    expect(card).toHaveTextContent('6.2%');
    expect(card).toHaveTextContent('₹6,638');
    expect(card).toHaveTextContent('₹3,462');
    expect(card).toHaveTextContent('SIMULATED');
    expect(card).toHaveTextContent('A simulation, not a field measurement.');
  });
});
