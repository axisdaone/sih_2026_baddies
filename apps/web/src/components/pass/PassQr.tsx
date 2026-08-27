/** QR of the pass URL (qrcode lib — only this page's chunk imports it). Tap to reveal the link. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';

export function PassQr({ url }: { url: string }): JSX.Element {
  const { t } = useTranslation('pass');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 512, margin: 1, errorCorrectionLevel: 'M' })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <figure className="flex flex-col items-center">
      <button
        type="button"
        className="rounded-2xl border border-gray-200 bg-white p-2 shadow-sm"
        onClick={() => setRevealed((v) => !v)}
        aria-label={t('qr.tap_to_reveal')}
        aria-expanded={revealed}
      >
        {dataUrl ? (
          <img src={dataUrl} alt={t('qr.caption')} width={224} height={224} className="h-56 w-56 max-w-full" data-testid="pass-qr" />
        ) : (
          <span className="flex h-56 w-56 items-center justify-center text-sm text-gray-400">…</span>
        )}
      </button>
      <figcaption className="mt-2 text-center text-sm text-gray-600">{revealed ? t('qr.url') : t('qr.caption')}</figcaption>
      {revealed && (
        <p className="mt-1 max-w-full break-all rounded-lg bg-gray-100 px-3 py-2 text-center font-mono text-xs" data-testid="pass-url">
          {url}
        </p>
      )}
    </figure>
  );
}

export default PassQr;
