/**
 * Display name on the public Quality Pass (NFR privacy: opt-in, and reversible). The farmer chooses
 * whether a name is shown and what it is; Save writes the meta keys, marks the change dirty and
 * re-registers the device (POST /auth/device) so the server stores — or clears — the name. If the
 * device is offline the dirty flag makes the next online ensureDevice()/drain retry it.
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { ensureDevice } from '../../api/auth';
import { db, META_KEYS } from '../../db';
import { notify } from '../../alerts/toast';
import Button from '../Button';

export const DISPLAY_NAME_MAX = 120;

export function DisplayNameSection(): JSX.Element {
  const { t } = useTranslation('settings');
  const stored = useLiveQuery(async () => {
    const [name, share] = await Promise.all([db.getMeta<string>(META_KEYS.displayName), db.getMeta<boolean>(META_KEYS.shareDisplayName)]);
    return { name: typeof name === 'string' ? name : '', share: typeof share === 'boolean' ? share : typeof name === 'string' && name.trim() !== '' };
  }, []);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Mirror the stored values into the form until the farmer starts editing.
  useEffect(() => {
    if (!stored || dirty) return;
    setName(stored.name);
    setShare(stored.share);
  }, [stored, dirty]);

  const save = async () => {
    setSaving(true);
    try {
      const trimmed = name.trim().slice(0, DISPLAY_NAME_MAX);
      const shareNow = share && trimmed !== '';
      await db.setMeta(META_KEYS.displayName, trimmed);
      await db.setMeta(META_KEYS.shareDisplayName, shareNow);
      await db.setMeta(META_KEYS.displayNameDirty, true);
      setDirty(false);
      await ensureDevice({ force: true });
      notify.success(t('name.saved'));
    } catch {
      notify.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-label={t('name.title')}>
      <h2 className="text-lg font-semibold">{t('name.title')}</h2>
      <p className="mt-1 text-sm text-gray-600">{t('name.hint')}</p>
      <label className="mt-3 flex min-h-14 cursor-pointer items-center justify-between gap-3">
        <span className="font-semibold">{t('name.share')}</span>
        <input
          type="checkbox"
          className="h-7 w-7 shrink-0 accent-brand"
          checked={share}
          onChange={(e) => {
            setShare(e.target.checked);
            setDirty(true);
          }}
          aria-label={t('name.share')}
          data-testid="share-display-name"
        />
      </label>
      <label htmlFor="display-name" className="mt-2 block text-sm font-semibold text-gray-700">
        {t('name.label')}
      </label>
      <input
        id="display-name"
        type="text"
        className="mt-1 min-h-12 w-full rounded-xl border-2 border-gray-200 px-3 text-base disabled:bg-gray-50 disabled:text-gray-400"
        value={name}
        maxLength={DISPLAY_NAME_MAX}
        placeholder={t('name.placeholder')}
        disabled={!share}
        onChange={(e) => {
          setName(e.target.value);
          setDirty(true);
        }}
      />
      <Button variant="secondary" className="mt-3" fullWidth onClick={() => void save()} loading={saving} disabled={!dirty || saving} data-testid="save-display-name">
        {t('name.save')}
      </Button>
    </section>
  );
}

export default DisplayNameSection;
