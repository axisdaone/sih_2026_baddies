/**
 * FarmSignal shared types — the TypeScript mirror of docs/ENGINEERING-CONTRACT.md.
 * Every other module imports wire/domain types from here. Keep field names snake_case (wire format).
 * All timestamps are ISO-8601 UTC strings ("2026-08-27T06:30:00Z"); all ids are UUID v4 strings.
 */

// ---------------------------------------------------------------------------
// §2.1 Decay protocols (data-driven; same evaluator for crop and pharma)
// ---------------------------------------------------------------------------

export type ProtocolKind = 'crop' | 'pharma';
export type KineticsModel = 'q10' | 'excursion';
export type HardThresholdType = 'max_temp' | 'min_temp';

export interface HardThreshold {
  type: HardThresholdType;
  value_c: number;
  /** e.g. "heat_damage", "freeze", "heat_excursion" */
  label: string;
}

export interface DecayProtocol {
  id: string;
  kind: ProtocolKind;
  name: string;
  /** Agmarknet commodity name (crop only). */
  commodity: string | null;
  version: string;
  model: KineticsModel;
  reference_temp_c: number;
  /** L_ref at T_ref (nominal); for excursion = budget in hours. */
  reference_shelf_life_hours: number;
  /** [pessimistic, optimistic] */
  reference_shelf_life_range_hours: [number, number];
  q10: number | null;
  /** [optimistic, pessimistic] — lower Q10 = slower decay above T_ref */
  q10_range: [number, number] | null;
  /** Chilling-injury floor: below this the rate does not decrease further. */
  min_effective_temp_c: number | null;
  max_effective_temp_c: number | null;
  /** Assumed temperature when no readings exist. */
  default_ambient_c: number;
  hard_thresholds: HardThreshold[];
  /** Pharma only: [low, high] */
  band_c: [number, number] | null;
  /** Pharma only. */
  excursion_budget_minutes: number | null;
  /** Literature citations (free text). */
  sources: string[];
}

// ---------------------------------------------------------------------------
// §2.2 ShelfLifeEstimate (identical JSON from Python and TS evaluators)
// ---------------------------------------------------------------------------

export type ShelfLifeStatus = 'fresh' | 'warning' | 'critical' | 'spoiled';
export type Confidence = 'high' | 'medium' | 'low';
/** Percent of shelf life remaining at which an alert fires. */
export type AlertThreshold = 75 | 50 | 25;
export const ALERT_THRESHOLDS: readonly AlertThreshold[] = [75, 50, 25] as const;

/** low = pessimistic, mid = nominal, high = optimistic. */
export interface Scenarios<T> {
  low: T;
  mid: T;
  high: T;
}

export interface TemperatureSegment {
  from: string;
  to: string;
  temp_c: number;
  hours: number;
  /** Rate multiplier r(T) applied over this segment. */
  rate: number;
  /** true when the temperature was assumed (default ambient, or a stale last reading). */
  assumed: boolean;
}

export interface ThresholdBreach {
  type: HardThresholdType;
  /** The hard threshold's `value_c` that was crossed (not the reading's temperature) — same as Python. */
  value_c: number;
  /** The first reading (time order) that crossed it. */
  reading_id: string;
  at: string;
  /** The hard threshold's `label` (e.g. "heat_damage", "freeze"); null when the protocol has none. */
  label: string | null;
}

export interface ShelfLifeEstimate {
  protocol_id: string;
  /** "kinetics-1.0" */
  model_version: string;
  computed_at: string;
  status: ShelfLifeStatus;
  confidence: Confidence;
  /** mid scenario, 4 dp */
  consumed_fraction: number;
  remaining_fraction: number;
  /** 1 dp */
  remaining_hours: Scenarios<number>;
  expected_end: Scenarios<string>;
  current_temp_c: number;
  current_temp_assumed: boolean;
  /** null when the batch has no readings. */
  hours_since_last_reading: number | null;
  /** Σ hours × max(0, T − reference_temp_c), 1 dp */
  thermal_load_degree_hours: number;
  alerts_crossed: AlertThreshold[];
  breach: ThresholdBreach | null;
  segments: TemperatureSegment[];
}

/** Minimal reading shape the kinetics evaluator needs (engine/ and worker/). */
export interface ReadingInput {
  id: string;
  temp_c: number;
  taken_at: string;
}

/** Input message for the kinetics Web Worker (contract §9). */
export interface KineticsInput {
  protocol: DecayProtocol;
  harvested_at: string;
  readings: ReadingInput[];
  now: string;
}

// ---------------------------------------------------------------------------
// §6.1 Wire schemas
// ---------------------------------------------------------------------------

export type Crop = 'tomato' | 'guava';
export type ReadingSource = 'manual' | 'sim' | 'ble';
export type BatchStatus = 'open' | 'sold' | 'spoiled' | 'discarded';

export interface BatchCreate {
  id: string;
  crop: Crop;
  protocol_id: string;
  qty_kg: number;
  harvested_at: string;
  origin_lat: number | null;
  origin_lon: number | null;
  notes?: string | null;
  client_seq: number;
  client_created_at: string;
}

export interface Batch extends BatchCreate {
  farmer_id: string;
  status: BatchStatus;
  origin_geohash: string | null;
  created_at: string;
  updated_at: string;
  shelf_life?: ShelfLifeEstimate;
  readings?: Reading[];
  chain_head?: string | null;
}

/** PATCH /batches/{id} body — last-writer-wins per field by client_seq. */
export interface BatchPatch {
  id: string;
  status?: BatchStatus;
  notes?: string | null;
  qty_kg?: number;
  client_seq: number;
}

export interface ReadingCreate {
  id: string;
  batch_id: string;
  temp_c: number;
  taken_at: string;
  source: ReadingSource;
  geohash?: string | null;
  client_seq: number;
}

export interface Reading extends ReadingCreate {
  /** 1-based per batch, assigned by the server on accept. */
  seq: number;
  hash: string;
  prev_hash: string;
  received_at: string;
}

export type PriceSource = 'agmarknet_live' | 'agmarknet_cache' | 'bundled_snapshot';

export interface MandiCandidate {
  mandi_id: string;
  name: string;
  district: string;
  lat: number;
  lon: number;
  straight_km: number;
  distance_km: number;
  travel_hours: number;
  feasible: boolean;
  /** Reachable even under the pessimistic (low) shelf-life scenario × safety factor. */
  feasible_pessimistic?: boolean;
  /** null when the candidate has no price (schemas/recommendation.py). */
  modal_price_per_quintal: number | null;
  /** ISO date (YYYY-MM-DD); null when the candidate has no price (schemas/recommendation.py). */
  price_reported_on: string | null;
  price_fetched_at: string | null;
  /** Whole days between the Agmarknet arrival date and the recommendation date. */
  price_age_days?: number | null;
  price_is_stale: boolean;
  price_source: PriceSource | string;
  /** Explanation inputs so the "why" screen can reproduce every number by hand. */
  qty_kg?: number;
  transit_temp_c: number;
  transit_rate?: number;
  reference_shelf_life_hours?: number;
  /** Shelf-life fraction consumed during the trip alone (consumed_at_arrival − consumed_now). */
  trip_consumed_fraction?: number;
  consumed_at_arrival: number;
  spoilage_at_arrival: number;
  gross_value_inr: number;
  transport_cost_inr: number;
  expected_value_inr: number;
  /** Explanation codes, e.g. "highest_expected_value", "price_stale", "risky_in_pessimistic_case" */
  reasons: string[];
  /** Rejection code, e.g. "too_far_for_shelf_life", "negative_expected_value", "no_price" */
  reason?: string | null;
}

export interface RoutingConstants {
  road_factor: number;
  avg_speed_kmh: number;
  safety_factor: number;
  transport_cost_per_km_inr: number;
}

export interface Recommendation {
  batch_id: string;
  computed_at: string;
  /** "routing-1.0" */
  model_version: string;
  shelf_life: ShelfLifeEstimate;
  top: MandiCandidate | null;
  alternatives: MandiCandidate[];
  nearest: MandiCandidate | null;
  rejected: MandiCandidate[];
  /** Every feasible mandi in rank order (top, alternatives, then the rest). Older cached payloads may omit it. */
  ranked?: MandiCandidate[];
  uplift_vs_nearest_pct: number | null;
  /** e.g. "batch_spoiled" when top is null */
  reason?: string;
  constants: RoutingConstants;
  simulated: boolean;
}

// ---------------------------------------------------------------------------
// §6 Auth / health / quality pass
// ---------------------------------------------------------------------------

export interface DeviceAuthRequest {
  device_id: string;
  display_name?: string;
  locale?: string;
}

export interface DeviceAuthResponse {
  token: string;
  farmer_id: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  db: string;
  prices: { source: PriceSource | string; fetched_at: string | null; stale: boolean };
}

/**
 * GET /quality-pass/{id}/verify[?head=] — mirrors services/api/app/schemas/quality_pass.py
 * (QualityPassVerify). The on-device verifier (engine/hashchain) returns the same shape.
 */
export interface ChainVerifyResponse {
  /** Chain internally consistent (every hash recomputes). */
  valid: boolean;
  /** Recomputed head; differs from the stored one when tampered. null for an empty chain. */
  chain_head: string | null;
  length: number;
  first_bad_seq: number | null;
  /**
   * true when the caller's `head` (>= 16 hex, from the QR) is a prefix of chain_head.
   * false when no head was supplied (chain checked, QR head not checked). Absent from the local verifier.
   */
  head_matches?: boolean;
}

/** One timeline row on the public page; `hash` is a 12-hex display prefix (PassReading). */
export interface PassReading {
  seq: number;
  temp_c: number;
  taken_at: string;
  source: ReadingSource;
  hash: string;
}

/**
 * GET /quality-pass/{id} public payload — mirrors services/api/app/schemas/quality_pass.py
 * (QualityPassPayload) field for field. No farmer identity beyond an opted-in display name and
 * no exact origin (geohash precision 4 + a coarse region label).
 */
export interface QualityPassPayload {
  batch_id: string;
  crop: Crop | string;
  protocol_id: string;
  protocol_name: string;
  qty_kg: number;
  harvested_at: string;
  status: BatchStatus;
  /** Precision-4 cell (~20 km), never the exact origin. */
  origin_geohash: string | null;
  /** Coarse label ("Dharmapuri belt") or null. */
  region: string | null;
  display_name: string | null;
  readings: PassReading[];
  shelf_life: ShelfLifeEstimate | null;
  chain_head: string | null;
  chain_length: number;
  /** Recomputed from the stored readings on every request. */
  chain_valid: boolean;
  generated_at: string;
  /** Any reading with source "sim" — the UI shows the SIMULATED chip. */
  simulated: boolean;
  /** `{PUBLIC_BASE_URL}/pass/{id}?h={chain_head[:16]}` (no `?h` while the chain is empty). */
  pass_url: string;
  verify_url: string;
}

/** One side of the demo loss comparison (data/demo_scenarios/demo_seed.json → loss_comparison). */
export interface LossComparisonSide {
  label: string;
  scenario: string;
  evaluate_at_offset_hours: number;
  mandi_id: string;
  explanation: string;
  /** Shelf-life fraction consumed at sale, percent (e.g. 18.3). */
  expected_loss_pct: number;
  expected_value_inr: number;
}

/** The "18 % → 7 %" pitch comparison, computed by the engine over simulated readings. */
export interface LossComparison {
  title: string;
  crop: string;
  qty_kg: number;
  baseline: LossComparisonSide;
  farmsignal: LossComparisonSide;
  honesty_note: string;
}

/** POST /demo/seed — mirrors services/api/app/schemas/demo.py (DemoSeedResponse). */
export interface DemoSeedResponse {
  farmer_id: string;
  /** "demo-device-001" */
  device_id: string;
  display_name: string | null;
  token: string;
  batch_ids: string[];
  /** true when this call created at least one batch (false on an idempotent replay). */
  created: boolean;
  batches_created: number;
  batches_existing: number;
  readings_created: number;
  /** Passed through verbatim from demo_seed.json; optional because older servers / mocks omit it. */
  loss_comparison?: LossComparison;
  /** F6 view of the seeded batches. */
  alerts: BatchAlert[];
  /** Every seeded reading is `source: "sim"`; the UI must label it. */
  simulated: boolean;
}

// ---------------------------------------------------------------------------
// Mandis (data/mandis.json) and §8 prices
// ---------------------------------------------------------------------------

export interface Mandi {
  /** slug, e.g. "koyambedu" */
  id: string;
  name: string;
  state: string;
  district: string;
  lat: number;
  lon: number;
  agmarknet_market: string;
  agmarknet_state: string;
  agmarknet_district: string;
}

export interface MandisFile {
  version: string;
  region: string;
  note: string;
  demo_origin: { label: string; lat: number; lon: number };
  mandis: Mandi[];
}

/** One mandi's latest price for a commodity (mirrors the mandi_prices row). */
export interface PriceQuote {
  mandi_id: string;
  commodity: string;
  variety: string | null;
  /** INR per quintal */
  modal_price: number;
  min_price: number | null;
  max_price: number | null;
  arrival_qty: number | null;
  /** ISO date (YYYY-MM-DD) */
  reported_on: string;
  fetched_at: string;
  source: PriceSource;
}

/** GET /prices?commodity=Tomato */
export interface PricesResponse {
  commodity: string;
  source: PriceSource;
  fetched_at: string | null;
  stale: boolean;
  prices: PriceQuote[];
}

// ---------------------------------------------------------------------------
// §7 Offline sync
// ---------------------------------------------------------------------------

export type SyncOpKind = 'batch.create' | 'batch.update' | 'reading.append';
export type SyncOpStatus = 'pending' | 'inflight' | 'done' | 'failed';
export type SyncResultStatus = 'applied' | 'duplicate' | 'rejected';

interface SyncOpBase {
  op_id: string;
  /** Monotonic per device. */
  client_seq: number;
  client_time: string;
}

/** Discriminated by `kind` so the payload type follows. */
export type SyncOp =
  | (SyncOpBase & { kind: 'batch.create'; payload: BatchCreate })
  | (SyncOpBase & { kind: 'batch.update'; payload: BatchPatch })
  | (SyncOpBase & { kind: 'reading.append'; payload: ReadingCreate });

export interface SyncRequest {
  device_id: string;
  client_now: string;
  ops: SyncOp[];
}

export interface SyncOpResult {
  op_id: string;
  status: SyncResultStatus;
  error: string | null;
  entity: Batch | Reading | null;
  /** true when the server shifted timestamps because |clock skew| > 120 s */
  clock_adjusted?: boolean;
}

/** A shelf-life threshold crossing (PRD F6). `message_key` doubles as the voice-clip key. */
export interface AlertEvent {
  /** null for the `sell_now` event */
  threshold: AlertThreshold | null;
  status: ShelfLifeStatus;
  /** alert_75 | alert_50 | alert_25 | sell_now */
  message_key: string;
}

export interface BatchAlert extends AlertEvent {
  batch_id: string;
}

export interface SyncResponse {
  server_now: string;
  /** client_now − server_now, seconds */
  clock_skew_seconds: number;
  results: SyncOpResult[];
  /** Full Batch[] for this farmer, with shelf_life. */
  batches: Batch[];
  /** Server-side view of F6 for every open batch of this farmer (computed from `batches`). */
  alerts?: BatchAlert[];
}

// ---------------------------------------------------------------------------
// UI-level helpers
// ---------------------------------------------------------------------------

export type Locale = 'en' | 'hi' | 'ta';
export const LOCALES: readonly Locale[] = ['en', 'hi', 'ta'] as const;

/** Voice clip keys (contract §9). */
export type VoiceKey =
  | 'welcome'
  | 'batch_logged'
  | 'alert_75'
  | 'alert_50'
  | 'alert_25'
  | 'sell_now'
  | 'recommendation_ready';
export const VOICE_KEYS: readonly VoiceKey[] = [
  'welcome',
  'batch_logged',
  'alert_75',
  'alert_50',
  'alert_25',
  'sell_now',
  'recommendation_ready',
] as const;
