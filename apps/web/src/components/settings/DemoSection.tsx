/**
 * Demo controls (DEMO-SCRIPT.md): "Use demo identity & load demo data" (POST /demo/seed → token →
 * meta identity → drain()), "use demo origin" toggle, reset local data, reload app.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { api, setToken } from '../../api/client';
import { db, META_KEYS } from '../../db';
import { DEMO_ORIGIN } from '../../data';
import { drain } from '../../sync';
import { notify } from '../../alerts/toast';
import Button from '../Button';
import type { Batch, Reading } from '../../types';

/** Contract §6: POST /demo/seed response (services/api/app/schemas/demo.py). */
export interface DemoSeedResponse {
  farmer_id: string;
  device_id: string;
  token: string;
  batch_ids?: string[];
  created?: boolean;
  display_name?: string | null;
}

export const DEMO_DEVICE_ID = 'demo-device-001';
export const DEMO_DISPLAY_NAME = 'Muthu';
/** meta key: {lat, lon, label} when the farmer wants the demo origin used where GPS is unavailable. */
export const DEMO_ORIGIN_META_KEY = 'demo_origin';

/**
 * Belt-and-braces pull when drain() has nothing to report (e.g. the outbox was empty and the sync
 * module skipped the round-trip): GET /batches + readings, stored as synced rows.
 */
async function pullBatchesDirect(): Promise<number> {
  const batches = await api.get<Batch[]>('/batches');
  for (const b of batches) {
    await db.batches.put({ ...b, readings: undefined, synced: true });
    try {
      const readings = await api.get<Reading[]>(`/batches/${b.id}/readings`);
      if (readings.length) await db.readings.bulkPut(readings.map((r) => ({ ...r, synced: true })));
    } catch {
      /* readings are optional for the list view */
    }
  }
  return batches.length;
}

export async function loadDemo(): Promise<{ name: string; count: number }> {
  const res = await api.post<DemoSeedResponse>('/demo/seed', {}, { anonymous: true });
  setToken(res.token);
  const name = res.display_name ?? DEMO_DISPLAY_NAME;
  await db.setMeta(META_KEYS.deviceId, res.device_id || DEMO_DEVICE_ID);
  await db.setMeta(META_KEYS.farmerId, res.farmer_id);
  await db.setMeta(META_KEYS.displayName, name);
  let count = 0;
  try {
    const sync = await drain();
    count = sync?.batches.length ?? 0;
  } catch {
    count = 0;
  }
  if (count === 0) {
    try {
      count = await pullBatchesDirect();
    } catch {
      count = res.batch_ids?.length ?? 0;
    }
  }
  return { name, count };
}

export function DemoSection(): JSX.Element {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const demoOrigin = useLiveQuery(() => db.getMeta<{ lat: number; lon: number }>(DEMO_ORIGIN_META_KEY), [], undefined);

  const onLoad = async () => {
    setBusy(true);
    try {
      const { name, count } = await loadDemo();
      notify.success(t('demo.loaded'), t('demo.loaded_body', { name, count }), { simulated: true });
    } catch {
      notify.error(t('demo.failed'), t('demo.failed_body'));
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    setBusy(true);
    try {
      await db.delete();
      setToken(null);
    } finally {
      window.location.reload();
    }
  };

  const toggleDemoOrigin = async (on: boolean) => {
    if (on) await db.setMeta(DEMO_ORIGIN_META_KEY, { lat: DEMO_ORIGIN.lat, lon: DEMO_ORIGIN.lon, label: DEMO_ORIGIN.label });
    else await db.meta.delete(DEMO_ORIGIN_META_KEY);
  };

  return (
    <section className="card" aria-label={t('demo.title')}>
      <h2 className="text-lg font-semibold">{t('demo.title')}</h2>
      <p className="mt-1 text-sm text-gray-600">{t('demo.desc')}</p>
      <div className="mt-3 flex flex-col gap-3">
        <Button onClick={() => void onLoad()} loading={busy} fullWidth data-testid="load-demo">
          {busy ? t('demo.loading') : t('demo.load')}
        </Button>
        <label className="flex min-h-14 cursor-pointer items-center justify-between gap-3">
          <span>
            <span className="block font-semibold">{t('demo.demo_origin')}</span>
            <span className="block text-sm text-gray-600">{t('demo.demo_origin_desc', { label: DEMO_ORIGIN.label, lat: DEMO_ORIGIN.lat, lon: DEMO_ORIGIN.lon })}</span>
          </span>
          <input type="checkbox" className="h-7 w-7 shrink-0 accent-brand" checked={Boolean(demoOrigin)} onChange={(e) => void toggleDemoOrigin(e.target.checked)} aria-label={t('demo.demo_origin')} />
        </label>
        <Button variant="secondary" onClick={() => window.location.reload()} fullWidth>
          {t('demo.reload')}
        </Button>
        {!confirming ? (
          <Button variant="danger" onClick={() => setConfirming(true)} fullWidth>
            {t('demo.reset')}
          </Button>
        ) : (
          <div className="rounded-xl border-2 border-spoiled p-3" role="alertdialog" aria-label={t('demo.reset_confirm')}>
            <p className="font-semibold">{t('demo.reset_confirm')}</p>
            <p className="text-sm text-gray-600">{t('demo.reset_desc')}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setConfirming(false)}>
                {t('demo.reset_no')}
              </Button>
              <Button variant="danger" className="flex-1" onClick={() => void onReset()} loading={busy}>
                {t('demo.reset_yes')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default DemoSection;
