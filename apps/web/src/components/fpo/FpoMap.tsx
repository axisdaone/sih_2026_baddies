/**
 * Leaflet map for the FPO dashboard (react-leaflet; only this chunk imports Leaflet).
 * Batch markers at origin (divIcon coloured by status — no default-icon image lookups), mandi
 * markers with the latest cached tomato/guava price, and a line from the selected batch to its
 * cached recommendation (db.meta 'rec:<batchId>').
 */
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import { DEMO_ORIGIN, MANDIS } from '../../data';
import type { PriceRow } from '../../db';
import { useFormat } from '../../i18n/useFormat';
import type { Mandi, Recommendation, ShelfLifeStatus } from '../../types';
import { STATUS_HEX } from '../pass/StatusChip';
import type { UrgencyItem } from './useEstimates';

const PRICE_COMMODITIES = ['Tomato', 'Guava'] as const;
const MANDI_HEX = '#1d4ed8';
const CLOSED_HEX = '#6b7280';

export interface FpoMapProps {
  items: UrgencyItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  prices: PriceRow[];
  recommendation: Recommendation | null;
  /** CSS height; Leaflet needs an explicit container height. */
  height?: string;
}

function batchIcon(status: ShelfLifeStatus | null, selected: boolean, closed: boolean): L.DivIcon {
  const hex = closed ? CLOSED_HEX : status ? STATUS_HEX[status] : '#9ca3af';
  const size = selected ? 24 : 18;
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${hex};border:3px solid #fff;box-shadow:0 0 0 2px ${hex}${selected ? ',0 0 0 6px rgba(22,101,52,.25)' : ''}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function mandiIcon(recommended: boolean): L.DivIcon {
  const size = recommended ? 18 : 14;
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:${size}px;height:${size}px;background:${MANDI_HEX};border:2px solid #fff;box-shadow:0 0 0 1.5px ${MANDI_HEX};transform:rotate(45deg)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/** Latest quote per (mandi, commodity) from the local price cache. */
export function latestPrices(prices: PriceRow[]): Map<string, PriceRow> {
  const map = new Map<string, PriceRow>();
  for (const p of prices) {
    const key = `${p.mandi_id}|${p.commodity}`;
    const cur = map.get(key);
    if (!cur || p.reported_on > cur.reported_on) map.set(key, p);
  }
  return map;
}

/** Fits the view to every marker once (and again when the marker set changes). */
function FitBounds({ points }: { points: Array<[number, number]> }): null {
  const map = useMap();
  // Serialised so a re-render with the same coordinates does not re-fit (and fight the user's pan).
  const key = points.map((p) => p.join(',')).join(';');
  useEffect(() => {
    const pts = key ? key.split(';').map((s) => s.split(',').map(Number) as [number, number]) : [];
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], 10);
      return;
    }
    map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 11 });
  }, [map, key]);
  return null;
}

export function FpoMap({ items, selectedId, onSelect, prices, recommendation, height = '50vh' }: FpoMapProps): JSX.Element {
  const { t } = useTranslation('fpo');
  const f = useFormat();
  const quotes = useMemo(() => latestPrices(prices), [prices]);
  const located = items.filter((i) => i.batch.origin_lat !== null && i.batch.origin_lon !== null);
  const selected = located.find((i) => i.batch.id === selectedId) ?? null;
  const recTop = recommendation && recommendation.batch_id === selectedId ? recommendation.top : null;
  const recMandi: Mandi | undefined = recTop ? MANDIS.find((m) => m.id === recTop.mandi_id) : undefined;
  const line: Array<[number, number]> | null =
    selected && recTop ? [[selected.batch.origin_lat as number, selected.batch.origin_lon as number], [recMandi?.lat ?? recTop.lat, recMandi?.lon ?? recTop.lon]] : null;
  const points: Array<[number, number]> = [
    ...located.map((i) => [i.batch.origin_lat as number, i.batch.origin_lon as number] as [number, number]),
    ...MANDIS.map((m) => [m.lat, m.lon] as [number, number]),
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200" style={{ height }} data-testid="fpo-map">
      <MapContainer center={[DEMO_ORIGIN.lat, DEMO_ORIGIN.lon]} zoom={8} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution={t('map.tiles_attribution')} url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitBounds points={points} />
        {MANDIS.map((m) => {
          const isRec = recTop?.mandi_id === m.id;
          return (
            <Marker key={m.id} position={[m.lat, m.lon]} icon={mandiIcon(isRec)}>
              <Popup>
                <strong>{m.name}</strong> · {m.district}
                {isRec && <div className="text-xs font-semibold text-blue-800">{t('map.recommended')}</div>}
                <ul className="mt-1 text-xs">
                  {PRICE_COMMODITIES.map((c) => {
                    const q = quotes.get(`${m.id}|${c}`);
                    return (
                      <li key={c}>
                        {c}: {q ? `${t('map.price', { price: f.inr(q.modal_price) })} · ${t('map.price_reported', { date: q.reported_on })}` : t('map.no_price')}
                      </li>
                    );
                  })}
                </ul>
              </Popup>
            </Marker>
          );
        })}
        {located.map(({ batch, estimate }) => (
          <Marker
            key={batch.id}
            position={[batch.origin_lat as number, batch.origin_lon as number]}
            icon={batchIcon(estimate?.status ?? null, batch.id === selectedId, batch.status !== 'open')}
            eventHandlers={{ click: () => onSelect(batch.id) }}
            zIndexOffset={batch.id === selectedId ? 1000 : 0}
          >
            <Popup>
              <strong>
                {t(`crop.${batch.crop}`, { defaultValue: batch.crop })} · {f.kg(batch.qty_kg)}
              </strong>
              <div className="text-xs">
                {estimate ? f.hoursRange(estimate.remaining_hours.low, estimate.remaining_hours.high, estimate.remaining_hours.mid) : t('list.no_estimate')}
              </div>
              {batch.id === selectedId && !recTop && <div className="text-xs text-gray-600">{t('map.no_recommendation')}</div>}
            </Popup>
          </Marker>
        ))}
        {line && <Polyline positions={line} pathOptions={{ color: selected?.estimate ? STATUS_HEX[selected.estimate.status] : MANDI_HEX, weight: 4, dashArray: '8 6' }} />}
      </MapContainer>
    </div>
  );
}

export default FpoMap;
