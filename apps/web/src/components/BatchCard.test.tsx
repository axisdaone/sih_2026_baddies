import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import type { BatchRow } from '../db';
import type { ShelfLifeEstimate } from '../types';
import { BatchCard } from './BatchCard';

const batch: BatchRow = {
  id: '77777777-7777-4777-8777-777777777777',
  crop: 'tomato',
  protocol_id: 'tomato',
  qty_kg: 100,
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
  synced: false,
};

const estimate: ShelfLifeEstimate = {
  protocol_id: 'tomato',
  model_version: 'kinetics-1.0',
  computed_at: '2026-08-27T06:00:00Z',
  status: 'fresh',
  confidence: 'low',
  consumed_fraction: 0.2,
  remaining_fraction: 0.8,
  remaining_hours: { low: 55, mid: 72, high: 95 },
  expected_end: { low: '2026-08-29T09:00:00Z', mid: '2026-08-30T02:00:00Z', high: '2026-08-31T01:00:00Z' },
  current_temp_c: 30,
  current_temp_assumed: true,
  hours_since_last_reading: null,
  thermal_load_degree_hours: 40,
  alerts_crossed: [],
  breach: null,
  segments: [],
};

function renderCard(est: ShelfLifeEstimate | null) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <BatchCard batch={batch} readings={[]} estimate={est} />
    </MemoryRouter>,
  );
}

describe('BatchCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows a text chip when the range assumes the ambient temperature', () => {
    renderCard(estimate);
    expect(screen.getByTestId('card-range')).toHaveTextContent('≈ 55–95 h (most likely 72 h)');
    expect(screen.getByTestId('card-assumed')).toHaveTextContent('Temp. assumed');
    expect(screen.getByRole('img', { name: 'Not yet synced' })).toBeInTheDocument();
  });

  it('shows no chip once a reading drives the estimate', () => {
    renderCard({ ...estimate, current_temp_assumed: false, hours_since_last_reading: 0.5 });
    expect(screen.queryByTestId('card-assumed')).not.toBeInTheDocument();
  });
});
