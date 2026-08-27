/**
 * Threshold alerts (contract §2.2 step 9, PRD F6): fire once per batch per threshold (75/50/25 %)
 * with an in-app notice + voice clip (alert_75 / alert_50 / alert_25). Fired thresholds are
 * remembered in Dexie meta so they do not repeat on every 60 s recompute.
 */
import type { AlertThreshold, ShelfLifeEstimate } from '../types';
export { ALERT_THRESHOLDS } from '../types';

/**
 * Compare `estimate.alerts_crossed` with what was already fired for this batch and return the
 * newly crossed thresholds (highest first). Side effects (voice, toast) happen here too.
 * PHASE2: implemented by the alerts agent.
 */
export async function checkAlerts(batchId: string, estimate: ShelfLifeEstimate): Promise<AlertThreshold[]> {
  void batchId;
  void estimate;
  return [];
}
