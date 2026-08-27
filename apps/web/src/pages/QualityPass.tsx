/**
 * Public Quality Pass (/pass/:id, PublicLayout — no bottom nav). Loads GET /quality-pass/:id
 * anonymously; when that fails (offline / not yet synced) it falls back to the local Dexie copy and
 * recomputes the estimate + chain head on-device, labelled "Offline copy".
 *
 * Verification prefers the server: GET /quality-pass/:id/verify?head=<?h= from the QR>. `valid=false`
 * is TAMPERED (first_bad_seq) regardless of heads; `valid=true` + `head_matches=false` with a QR head
 * is TAMPERED (head mismatch); without a QR head the server cannot compare, so the badge reads
 * VERIFIED (chain consistent) with a "QR head not checked" note. Offline it verifies the local chain
 * (server-hashed rows only), else shows UNVERIFIED.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { db, type ReadingRow } from '@/db';
import { getProtocol } from '@/data';
import { estimateShelfLife } from '@/worker/client';
import { useFormat } from '@/i18n/useFormat';
import { useAppStatus } from '@/state/appStatus';
import { notify } from '@/alerts/toast';
import Button from '@/components/Button';
import { SimBadge } from '@/components/SimBadge';
import { FreshnessBand } from '@/components/pass/FreshnessBand';
import { ThermalTimeline, type TimelineReading } from '@/components/pass/ThermalTimeline';
import { VerifyBadge, type VerifyState } from '@/components/pass/VerifyBadge';
import { PassQr } from '@/components/pass/PassQr';
import { allSynced, localChainHead, localVerify, orderReadings, shortHead } from '@/components/pass/chain';
import type { BatchStatus, ChainVerifyResponse, Crop, QualityPassPayload, ShelfLifeEstimate } from '@/types';

export interface PassView {
  batch_id: string;
  crop: Crop;
  protocol_id: string;
  protocol_name: string | null;
  qty_kg: number;
  harvested_at: string;
  status: BatchStatus;
  display_name: string | null;
  region: string | null;
  readings: TimelineReading[];
  shelf_life: ShelfLifeEstimate | null;
  chain_head: string | null;
  /** Server: QualityPassPayload.chain_length; local: number of rows. */
  chain_length: number;
  /** Server: recomputed on every request; local copies assume true until verified. */
  chain_valid: boolean;
  /** Server payload timestamp (null for offline copies). */
  generated_at: string | null;
  /** Canonical public link from the server ({PUBLIC_BASE_URL}/pass/:id?h=…); null offline. */
  pass_url: string | null;
  simulated: boolean;
  source: 'server' | 'local';
  /** Local rows (when this device has them) for offline verification. */
  localRows: ReadingRow[];
}

async function localRowsFor(id: string): Promise<ReadingRow[]> {
  try {
    return orderReadings(await db.readings.where('batch_id').equals(id).toArray());
  } catch {
    return [];
  }
}

async function loadFromServer(id: string): Promise<PassView> {
  const p = await api.get<QualityPassPayload>(`/quality-pass/${id}`, { anonymous: true });
  // readings[].hash is the server's 12-hex display prefix, not a full digest.
  const readings: TimelineReading[] = (p.readings ?? []).map((r) => ({ seq: r.seq, temp_c: r.temp_c, taken_at: r.taken_at, source: r.source, hash: r.hash }));
  return {
    batch_id: p.batch_id,
    crop: p.crop as Crop,
    protocol_id: p.protocol_id,
    protocol_name: p.protocol_name ?? null,
    qty_kg: p.qty_kg,
    harvested_at: p.harvested_at,
    status: p.status,
    display_name: p.display_name ?? null,
    region: p.region ?? null,
    readings,
    shelf_life: p.shelf_life ?? null,
    chain_head: p.chain_head ?? null,
    chain_length: typeof p.chain_length === 'number' ? p.chain_length : readings.length,
    chain_valid: p.chain_valid !== false,
    generated_at: p.generated_at ?? null,
    pass_url: typeof p.pass_url === 'string' && /^https?:\/\//i.test(p.pass_url) ? p.pass_url : null,
    simulated: Boolean(p.simulated) || readings.some((r) => r.source === 'sim'),
    source: 'server',
    localRows: await localRowsFor(id),
  };
}

async function loadFromLocal(id: string): Promise<PassView | null> {
  const batch = await db.batches.get(id);
  if (!batch) return null;
  const rows = await localRowsFor(id);
  const protocol = getProtocol(batch.protocol_id);
  let shelf: ShelfLifeEstimate | null = batch.shelf_life ?? null;
  if (protocol) {
    try {
      shelf = await estimateShelfLife({
        protocol,
        harvested_at: batch.harvested_at,
        readings: rows.map((r) => ({ id: r.id, temp_c: r.temp_c, taken_at: r.taken_at })),
      });
    } catch {
      /* engine unavailable — keep the last server estimate if we have one */
    }
  }
  const head = allSynced(rows) ? (rows[rows.length - 1]?.hash ?? null) : await localChainHead(id, rows);
  return {
    batch_id: batch.id,
    crop: batch.crop,
    protocol_id: batch.protocol_id,
    protocol_name: protocol?.name ?? null,
    qty_kg: batch.qty_kg,
    harvested_at: batch.harvested_at,
    status: batch.status,
    display_name: null,
    region: null,
    readings: rows.map((r, i) => ({ seq: r.seq ?? i + 1, temp_c: r.temp_c, taken_at: r.taken_at, source: r.source, hash: r.hash })),
    shelf_life: shelf,
    chain_head: head,
    chain_length: rows.length,
    chain_valid: true,
    generated_at: null,
    pass_url: null,
    simulated: rows.some((r) => r.source === 'sim'),
    source: 'local',
    localRows: rows,
  };
}

const LOCAL_REFRESH_MS = 60_000;
/** Batch ids are UUID v4; anything else never reaches the API path (no `..%2F` games). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function QualityPass(): JSX.Element {
  const { t } = useTranslation('pass');
  const { t: tc } = useTranslation('common');
  const f = useFormat();
  const { id = '' } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const queryHead = search.get('h');
  const { online } = useAppStatus();

  const [view, setView] = useState<PassView | null>(null);
  const [loading, setLoading] = useState(true);
  const [verify, setVerify] = useState<VerifyState>({ kind: 'checking' });
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    if (!id || !UUID_RE.test(id)) {
      setView(null);
      setLoading(false);
      return;
    }
    let next: PassView | null = null;
    try {
      next = await loadFromServer(id);
    } catch {
      try {
        next = await loadFromLocal(id);
      } catch {
        next = null;
      }
    }
    setView(next);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Offline copies keep counting down (contract §9: recompute every 60 s).
  useEffect(() => {
    if (view?.source !== 'local') return;
    const timer = setInterval(() => void load(), LOCAL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [view?.source, load]);

  /** Head printed on the QR (?h=, >= 16 hex). Only this can be *checked*; the payload's own head cannot vouch for itself. */
  const qrHead = useMemo(() => (queryHead && /^[0-9a-f]{16,64}$/i.test(queryHead) ? queryHead.toLowerCase() : null), [queryHead]);

  const runVerify = useCallback(async () => {
    if (!view) return;
    setVerifying(true);
    setVerify({ kind: 'checking' });
    try {
      if (online) {
        try {
          const query = qrHead ? `?head=${encodeURIComponent(qrHead)}` : '';
          const res = await api.get<ChainVerifyResponse>(`/quality-pass/${view.batch_id}/verify${query}`, { anonymous: true });
          if (!res.valid) {
            // Broken chain: heads are irrelevant, report where it broke.
            setVerify({ kind: 'tampered', firstBadSeq: res.first_bad_seq, via: 'server' });
            return;
          }
          if (!qrHead) {
            if (res.length === 0 && !view.chain_head) {
              setVerify({ kind: 'unverified', reason: 'no_head' });
              return;
            }
            // No ?h= → the server answers head_matches=false by design; chain is consistent, QR head unchecked.
            setVerify({ kind: 'verified', length: res.length, via: 'server', headChecked: false });
            return;
          }
          const headMatches = typeof res.head_matches === 'boolean' ? res.head_matches : typeof res.chain_head === 'string' && res.chain_head.startsWith(qrHead);
          setVerify(headMatches ? { kind: 'verified', length: res.length, via: 'server', headChecked: true } : { kind: 'tampered', firstBadSeq: null, via: 'server' });
          return;
        } catch {
          /* server unreachable — try the local chain */
        }
      }
      if (view.source === 'server' && !view.chain_valid) {
        // The payload itself said the stored chain no longer recomputes (chain_valid is refreshed per request).
        setVerify({ kind: 'tampered', firstBadSeq: null, via: 'server' });
        return;
      }
      const rows = view.localRows;
      if (rows.length === 0) {
        setVerify({ kind: 'unverified', reason: 'offline' });
        return;
      }
      if (!allSynced(rows)) {
        setVerify({ kind: 'unverified', reason: 'unsynced' });
        return;
      }
      const res = await localVerify(view.batch_id, rows);
      if (!res.valid) {
        setVerify({ kind: 'tampered', firstBadSeq: res.first_bad_seq, via: 'local' });
        return;
      }
      // Compare against the QR head when we have one, else against the stored head (server hashes).
      const expected = qrHead ?? shortHead(view.chain_head);
      if (!expected) {
        setVerify({ kind: 'unverified', reason: 'no_head' });
        return;
      }
      const headMatches = typeof res.chain_head === 'string' && res.chain_head.startsWith(expected);
      setVerify(headMatches ? { kind: 'verified', length: res.length, via: 'local', headChecked: qrHead !== null } : { kind: 'tampered', firstBadSeq: null, via: 'local' });
    } catch {
      setVerify({ kind: 'unverified', reason: 'error' });
    } finally {
      setVerifying(false);
    }
  }, [view, qrHead, online]);

  useEffect(() => {
    if (view) void runVerify();
  }, [view, runVerify]);

  // Prefer the server's canonical pass_url (PUBLIC_BASE_URL); offline copies build the same shape locally.
  const passUrl = useMemo(() => {
    if (view?.pass_url) return view.pass_url;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    // Only the validated QR head may be re-embedded (never the raw ?h=, which anyone could craft).
    const h = shortHead(view?.chain_head) ?? qrHead;
    return `${origin}/pass/${id}${h ? `?h=${h}` : ''}`;
  }, [id, view?.pass_url, view?.chain_head, qrHead]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(passUrl);
      notify.success(t('link_copied'));
    } catch {
      notify.error(t('share_failed'), passUrl);
    }
  }, [passUrl, t]);

  const share = useCallback(async () => {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: tc('titles.pass'), text: view ? `${t(`crop.${view.crop}`)} · ${f.kg(view.qty_kg)}` : undefined, url: passUrl });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    await copyLink();
  }, [copyLink, passUrl, t, tc, view, f]);

  const protocol = view ? getProtocol(view.protocol_id) : undefined;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <header>
        <h1>{tc('titles.pass')}</h1>
        <p className="mt-1 text-sm text-gray-600">{t('subtitle')}</p>
        {view && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`chip ${view.source === 'server' ? 'bg-brand-100 text-brand-900' : 'bg-gray-200 text-gray-800'}`}
              title={view.source === 'local' ? t('source_local_hint') : undefined}
              data-testid="pass-source"
            >
              {view.source === 'server' ? t('source_server') : t('source_local')}
            </span>
            {view.simulated && <SimBadge />}
            {view.display_name && <span className="text-sm text-gray-600">{t('shared_by', { name: view.display_name })}</span>}
          </div>
        )}
        {view?.generated_at && (
          <p className="mt-1 text-xs text-gray-500" data-testid="pass-generated-at">
            {t('generated_at', { time: f.dateTime(view.generated_at) })}
          </p>
        )}
      </header>

      {loading && (
        <p className="text-gray-500" role="status">
          {t('loading')}
        </p>
      )}

      {!loading && !view && (
        <section className="card">
          <p className="font-semibold">{t('not_found')}</p>
          <p className="mt-1 text-sm text-gray-600">{t('not_found_hint')}</p>
          <p className="mt-2 break-all font-mono text-xs text-gray-400">{id}</p>
        </section>
      )}

      {view && (
        <>
          <section className="card" aria-label={tc('titles.batch')}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-2xl font-bold">
                  {t(`crop.${view.crop}`, { defaultValue: view.crop })} · {f.kg(view.qty_kg)}
                </p>
                <p className="text-sm text-gray-600">
                  {t('harvested')}: <span className="tabular">{f.dateTime(view.harvested_at)}</span>
                </p>
                {view.region && (
                  <p className="text-sm text-gray-600">
                    {t('region')}: {view.region}
                  </p>
                )}
              </div>
              <span className="chip bg-gray-100 text-gray-700">{t(`batch_status.${view.status}`, { defaultValue: view.status })}</span>
            </div>
            {view.simulated && <p className="mt-2 text-xs text-purple-800">{t('simulated_note')}</p>}
            {view.source === 'local' && <p className="mt-2 text-xs text-gray-500">{t('source_local_hint')}</p>}
          </section>

          <FreshnessBand estimate={view.shelf_life} protocol={protocol} simulated={view.simulated} />

          <ThermalTimeline readings={view.readings} harvestedAt={view.harvested_at} protocol={protocol} />

          <VerifyBadge state={verify} head={view.chain_head} chainLength={view.chain_length} onReverify={() => void runVerify()} busy={verifying} />

          <section className="card flex flex-col items-center gap-3">
            <PassQr url={passUrl} />
            <div className="flex w-full gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => void copyLink()}>
                {t('copy_link')}
              </Button>
              <Button className="flex-1" onClick={() => void share()}>
                {t('share')}
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
