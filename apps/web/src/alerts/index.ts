/**
 * Threshold alerts (contract §2.2 step 9, PRD F6): fire once per batch per threshold (75/50/25 %)
 * with an in-app toast, a Notification (permission requested lazily, never blocking) and a voice
 * clip (alert_75 / alert_50 / alert_25; plus sell_now the first time a batch turns critical).
 * Fired thresholds are remembered in Dexie meta ('alerts:<batchId>') so they do not repeat on every
 * 60 s recompute; the last 50 events are kept in meta 'alertlog' for the Settings / FPO views.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import i18n from '../i18n';
import { currentLocale } from '../i18n';
import { formatHoursRange, formatKg, formatNumber } from '../i18n/format';
import { play } from '../voice';
import type { AlertThreshold, ShelfLifeEstimate, ShelfLifeStatus, VoiceKey } from '../types';
import { ALERT_THRESHOLDS } from '../types';
import { pushToast } from './toast';
export { ALERT_THRESHOLDS } from '../types';
export { AlertHost } from './AlertHost';
export { pushToast, dismissToast, clearToasts, notify, useToasts, type Toast, type ToastKind } from './toast';

/** meta key holding the fired-set for one batch. */
export const alertsMetaKey = (batchId: string): string => `alerts:${batchId}`;
/** meta key holding the recent alert log (newest first, max ALERT_LOG_MAX). */
export const ALERT_LOG_KEY = 'alertlog';
export const ALERT_LOG_MAX = 50;

/** Persisted per batch. Older builds stored a bare number[]; readFired() migrates on read. */
export interface FiredState {
  fired: AlertThreshold[];
  /** ISO time the sell_now prompt was played (first time the batch became critical). */
  critical_at: string | null;
}

export interface AlertEvent {
  id: string;
  batch_id: string;
  /** 75 | 50 | 25, or "critical" for the sell-now prompt. */
  threshold: AlertThreshold | 'critical';
  status: ShelfLifeStatus;
  at: string;
  remaining_hours: ShelfLifeEstimate['remaining_hours'];
  crop?: string;
  qty_kg?: number;
  simulated?: boolean;
  /** Temperature the estimate used; `current_temp_assumed` = no reading, protocol ambient assumed. Optional: older 'alertlog' entries lack them. */
  current_temp_c?: number;
  current_temp_assumed?: boolean;
}

const VOICE_FOR_THRESHOLD: Record<AlertThreshold, VoiceKey> = { 75: 'alert_75', 50: 'alert_50', 25: 'alert_25' };

function readFired(raw: unknown): FiredState {
  if (Array.isArray(raw)) return { fired: raw.filter(isThreshold), critical_at: null };
  if (raw && typeof raw === 'object') {
    const obj = raw as Partial<FiredState>;
    return {
      fired: Array.isArray(obj.fired) ? obj.fired.filter(isThreshold) : [],
      critical_at: typeof obj.critical_at === 'string' ? obj.critical_at : null,
    };
  }
  return { fired: [], critical_at: null };
}

function isThreshold(v: unknown): v is AlertThreshold {
  return (ALERT_THRESHOLDS as readonly number[]).includes(v as number);
}

/** Batch context for the toast text; the estimate alone does not know the crop. */
async function batchContext(batchId: string): Promise<{ crop?: string; qty_kg?: number; simulated: boolean }> {
  try {
    const batch = await db.batches.get(batchId);
    if (!batch) return { simulated: false };
    const simCount = await db.readings.where('batch_id').equals(batchId).filter((r) => r.source === 'sim').count();
    return { crop: batch.crop, qty_kg: batch.qty_kg, simulated: simCount > 0 };
  } catch {
    return { simulated: false };
  }
}

/** Title + body for one event (feeds both the toast and the system notification). */
export function describe(event: AlertEvent): { title: string; body: string } {
  const locale = currentLocale();
  const t = (key: string, opts: Record<string, unknown> = {}) => i18n.t(key, { ns: 'alerts', lng: locale, ...opts });
  const crop = event.crop ? t(`crop.${event.crop}`, { defaultValue: event.crop }) : t('a_batch');
  const qty = typeof event.qty_kg === 'number' ? formatKg(event.qty_kg, locale) : '';
  const range = formatHoursRange(event.remaining_hours.low, event.remaining_hours.high, event.remaining_hours.mid, locale);
  const title = event.threshold === 'critical' ? t('critical_title') : t(`threshold_${event.threshold}`);
  let body = t('body', { crop, qty, range });
  // Honesty cue (PRD): the range came from an assumed temperature, not a reading.
  if (event.current_temp_assumed && typeof event.current_temp_c === 'number') {
    body += ` ${t('body_assumed', { temp: formatNumber(event.current_temp_c, locale) })}`;
  }
  return { title, body };
}

async function appendLog(event: AlertEvent): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    const existing = (await db.getMeta<AlertEvent[]>(ALERT_LOG_KEY)) ?? [];
    const next = [event, ...existing.filter((e) => e.id !== event.id)].slice(0, ALERT_LOG_MAX);
    await db.setMeta(ALERT_LOG_KEY, next);
  });
}

/** Lazy Notification permission + fire-and-forget system notification. Never throws, never blocks. */
async function systemNotify(title: string, body: string, tag: string): Promise<void> {
  try {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;
    // Prefer the service-worker path (works when the tab is in the background on Android).
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const options: NotificationOptions = { body, tag, icon: '/icons/icon-192.png', lang: currentLocale() };
    if (reg && typeof reg.showNotification === 'function') await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    /* notifications are best effort */
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `alert-${Date.now()}-${Math.random()}`;
}

/**
 * Compare `estimate.alerts_crossed` with what was already fired for this batch and return the
 * newly crossed thresholds (highest first). Side effects: toast per threshold, one system
 * notification, and one voice clip for the most urgent new threshold (plus sell_now the first time
 * the batch is critical). The read-modify-write of the fired-set is a Dexie transaction, so
 * concurrent calls (60 s tick + a new reading) cannot double-fire.
 */
export async function checkAlerts(batchId: string, estimate: ShelfLifeEstimate): Promise<AlertThreshold[]> {
  const crossed = (estimate.alerts_crossed ?? []).filter(isThreshold);
  const isCritical = estimate.status === 'critical' || estimate.status === 'spoiled';
  const now = new Date().toISOString();

  let fresh: AlertThreshold[] = [];
  let firstCritical = false;
  try {
    await db.transaction('rw', db.meta, async () => {
      const key = alertsMetaKey(batchId);
      const state = readFired(await db.getMeta(key));
      fresh = [...ALERT_THRESHOLDS].filter((th) => crossed.includes(th) && !state.fired.includes(th));
      firstCritical = isCritical && state.critical_at === null;
      if (fresh.length === 0 && !firstCritical) return;
      const next: FiredState = {
        fired: [...ALERT_THRESHOLDS].filter((th) => state.fired.includes(th) || fresh.includes(th)),
        critical_at: firstCritical ? now : state.critical_at,
      };
      await db.setMeta(key, next);
    });
  } catch {
    // Storage failure: still surface the alert this time rather than silently dropping it.
    fresh = [...ALERT_THRESHOLDS].filter((th) => crossed.includes(th));
    firstCritical = isCritical;
  }
  if (fresh.length === 0 && !firstCritical) return [];

  const ctx = await batchContext(batchId);
  const temp = { current_temp_c: estimate.current_temp_c, current_temp_assumed: estimate.current_temp_assumed };
  const events: AlertEvent[] = fresh.map((th) => ({
    id: newId(),
    batch_id: batchId,
    threshold: th,
    status: estimate.status,
    at: now,
    remaining_hours: estimate.remaining_hours,
    ...ctx,
    ...temp,
  }));
  if (firstCritical) {
    events.push({ id: newId(), batch_id: batchId, threshold: 'critical', status: estimate.status, at: now, remaining_hours: estimate.remaining_hours, ...ctx, ...temp });
  }

  for (const event of events) {
    const { title, body } = describe(event);
    pushToast({
      id: `alert-${batchId}-${event.threshold}`,
      kind: event.threshold === 'critical' ? 'critical' : 'alert',
      title,
      body,
      to: `/batch/${batchId}`,
      simulated: ctx.simulated,
      ttlMs: event.threshold === 'critical' || event.threshold === 25 ? 0 : undefined,
    });
    void appendLog(event);
  }

  // One system notification for the most urgent event (thresholds are sorted 75 → 25; critical wins).
  // The OS shade has no SIMULATED chip, so the label goes into the title (NFR: simulated data is always labelled).
  const urgent = events[events.length - 1];
  if (urgent) {
    const { title, body } = describe(urgent);
    const simPrefix = urgent.simulated ? `${i18n.t('simulated', { ns: 'common', lng: currentLocale() })} · ` : '';
    void systemNotify(simPrefix + title, body, `fs-alert-${batchId}`);
  }

  // Voice: the most urgent new threshold only (clips would otherwise overlap), then sell_now.
  const lowest = fresh[fresh.length - 1];
  if (lowest !== undefined) await play(VOICE_FOR_THRESHOLD[lowest]);
  if (firstCritical) await play('sell_now');

  return fresh;
}

/** Forget fired thresholds for a batch (e.g. after the batch is marked sold). */
export async function resetAlerts(batchId: string): Promise<void> {
  await db.meta.delete(alertsMetaKey(batchId));
}

/** Recent alerts, newest first (max 50), live-updated from Dexie. */
export function useAlertLog(): AlertEvent[] {
  return useLiveQuery(async () => (await db.getMeta<AlertEvent[]>(ALERT_LOG_KEY)) ?? [], [], [] as AlertEvent[]);
}

/** Non-hook accessor for the log (tests, exports). */
export async function getAlertLog(): Promise<AlertEvent[]> {
  return (await db.getMeta<AlertEvent[]>(ALERT_LOG_KEY)) ?? [];
}
