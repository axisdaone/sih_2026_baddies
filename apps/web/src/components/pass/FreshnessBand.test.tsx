import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { PROTOCOLS } from '../../data';
import type { ShelfLifeEstimate } from '../../types';
import { FreshnessBand } from './FreshnessBand';

const breached: ShelfLifeEstimate = {
  protocol_id: 'tomato',
  model_version: 'kinetics-1.0',
  computed_at: '2026-08-27T06:30:00Z',
  status: 'spoiled',
  confidence: 'high',
  consumed_fraction: 1,
  remaining_fraction: 0,
  remaining_hours: { low: 0, mid: 0, high: 0 },
  expected_end: { low: '2026-08-27T05:00:00Z', mid: '2026-08-27T05:00:00Z', high: '2026-08-27T05:00:00Z' },
  current_temp_c: 46,
  current_temp_assumed: false,
  hours_since_last_reading: 0.1,
  thermal_load_degree_hours: 300,
  alerts_crossed: [75, 50, 25],
  breach: { type: 'max_temp', value_c: 45, reading_id: 'r1', at: '2026-08-27T05:00:00Z', label: 'heat_damage' },
  segments: [],
};

describe('FreshnessBand', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each(['hi', 'ta'] as const)('translates the breach label instead of printing the raw code (%s)', async (lng) => {
    await i18n.changeLanguage(lng);
    render(<FreshnessBand estimate={breached} protocol={PROTOCOLS.tomato} />);
    const line = screen.getByTestId('freshness-breach');
    expect(line).not.toHaveTextContent('heat_damage');
    expect(line).toHaveTextContent(i18n.t('breach.heat_damage', { ns: 'batch', lng }));
    // 45 renders in the locale's numerals (४५ for hi by default, 45 for ta).
    expect(line.textContent).toMatch(/45|४५/);
  });

  it('names the progressbar and shows the translated label in English too', () => {
    render(<FreshnessBand estimate={breached} protocol={PROTOCOLS.tomato} />);
    expect(screen.getByTestId('freshness-breach')).toHaveTextContent('Hard limit breached: heat damage (45 °C)');
    expect(screen.getByRole('progressbar', { name: 'Remaining shelf life' })).toBeInTheDocument();
  });
});
