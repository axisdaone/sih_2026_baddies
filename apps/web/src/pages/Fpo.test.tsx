import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { db } from '@/db';
import { AppStatusProvider } from '@/state/appStatus';
import type { KineticsInput, ShelfLifeEstimate } from '@/types';

// Leaflet needs a sized DOM; the map is covered by its own props contract, so it is mocked here.
vi.mock('@/components/fpo/FpoMap', () => ({
  FpoMap: (props: { selectedId: string | null }) => <div data-testid="fpo-map-mock" data-selected={props.selectedId ?? ''} />,
}));
vi.mock('@/worker/client', () => ({
  estimateShelfLife: vi.fn(async (input: Omit<KineticsInput, 'now'>): Promise<ShelfLifeEstimate> => {
    const hot = input.readings.length > 0;
    return {
      protocol_id: input.protocol.id,
      model_version: 'kinetics-1.0',
      computed_at: '2026-08-27T06:30:00Z',
      status: hot ? 'critical' : 'fresh',
      confidence: hot ? 'high' : 'low',
      consumed_fraction: hot ? 0.8 : 0.1,
      remaining_fraction: hot ? 0.2 : 0.9,
      remaining_hours: hot ? { low: 4, mid: 8, high: 12 } : { low: 42, mid: 72, high: 104 },
      expected_end: { low: '2026-08-27T10:00:00Z', mid: '2026-08-27T14:00:00Z', high: '2026-08-27T18:00:00Z' },
      current_temp_c: hot ? 36 : 30,
      current_temp_assumed: !hot,
      hours_since_last_reading: hot ? 0.5 : null,
      thermal_load_degree_hours: 100,
      alerts_crossed: hot ? [75, 50, 25] : [],
      breach: null,
      segments: [],
    };
  }),
}));

import Fpo from './Fpo';

const HOT = '44444444-4444-4444-8444-444444444444';
const COOL = '55555555-5555-4555-8555-555555555555';

function batch(id: string, crop: 'tomato' | 'guava', qty: number) {
  return {
    id,
    crop,
    protocol_id: crop,
    qty_kg: qty,
    harvested_at: '2026-08-27T02:00:00Z',
    origin_lat: 12.3,
    origin_lon: 78.07,
    client_seq: 1,
    client_created_at: '2026-08-27T02:00:05Z',
    farmer_id: 'f1',
    status: 'open' as const,
    origin_geohash: null,
    created_at: '2026-08-27T02:00:05Z',
    updated_at: '2026-08-27T02:00:05Z',
    synced: true,
  };
}

function renderFpo() {
  return render(
    <AppStatusProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Fpo />
      </MemoryRouter>
    </AppStatusProvider>,
  );
}

describe('Fpo dashboard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await Promise.all([db.batches.clear(), db.readings.clear(), db.meta.clear(), db.prices.clear()]);
    await db.batches.bulkPut([batch(COOL, 'guava', 120), batch(HOT, 'tomato', 500)]);
    await db.readings.put({ id: 'r-hot', batch_id: HOT, temp_c: 36, taken_at: '2026-08-27T06:00:00Z', source: 'sim', client_seq: 2, seq: 1, synced: true });
  });

  it('lists every local batch by urgency with status pills, ranges and summary tiles', async () => {
    renderFpo();
    expect(screen.getByRole('heading', { name: 'FPO dashboard' })).toBeInTheDocument();
    const rows = await screen.findAllByTestId('batch-row');
    expect(rows).toHaveLength(2);
    await waitFor(() => expect(within(rows[0]).getByText('Sell now')).toBeInTheDocument());
    expect(rows[0]).toHaveAttribute('data-batch-id', HOT);
    expect(within(rows[0]).getByText('Tomato · 500 kg')).toBeInTheDocument();
    expect(within(rows[0]).getByText('SIMULATED')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/≈ 4–12 h \(most likely 8 h\)/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('Fresh')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/≈ 42–104 h \(most likely 72 h\)/)).toBeInTheDocument();

    expect(screen.getByTestId('kg-at-risk')).toHaveTextContent('500');
    expect(screen.getByTestId('count-critical')).toHaveTextContent('1');
    expect(screen.getByTestId('count-fresh')).toHaveTextContent('1');
    expect(screen.getByTestId('fpo-map-mock')).toHaveAttribute('data-selected', HOT);
  });

  it('filters by status and selects a batch for the map', async () => {
    renderFpo();
    await screen.findAllByTestId('batch-row');
    await waitFor(() => expect(screen.getByTestId('count-fresh')).toHaveTextContent('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Fresh', pressed: false }));
    await waitFor(() => expect(screen.getAllByTestId('batch-row')).toHaveLength(1));
    expect(screen.getByTestId('batch-row')).toHaveAttribute('data-batch-id', COOL);
    fireEvent.click(screen.getByTestId('batch-row'));
    expect(screen.getByTestId('fpo-map-mock')).toHaveAttribute('data-selected', COOL);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.getAllByTestId('batch-row')).toHaveLength(2));
  });

  it('shows the empty state when there are no batches', async () => {
    await db.batches.clear();
    await db.readings.clear();
    renderFpo();
    expect(await screen.findByText('No batches on this device yet.')).toBeInTheDocument();
  });
});
