/** Big image-like crop tiles (crop protocols only). One tap selects; the name is also read aloud by SR. */
import { useTranslation } from 'react-i18next';
import type { Crop, DecayProtocol } from '../types';
import { CropIcon } from './CropIcon';

export interface CropPickerProps {
  protocols: DecayProtocol[];
  value: Crop | null;
  onChange: (crop: Crop) => void;
}

export function CropPicker({ protocols, value, onChange }: CropPickerProps): JSX.Element {
  const { t } = useTranslation('batch');
  return (
    <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label={t('new.crop')}>
      {protocols.map((p) => {
        const selected = value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`crop-tile-${p.id}`}
            onClick={() => onChange(p.id as Crop)}
            className={`flex min-h-32 flex-col items-center justify-center gap-2 rounded-2xl border-4 p-3 text-lg font-bold transition ${
              selected ? 'border-brand bg-brand-50 text-brand-900 shadow-md' : 'border-gray-200 bg-white text-gray-800'
            }`}
          >
            <CropIcon crop={p.id} size={72} />
            <span>{t(`crops.${p.id}`, { defaultValue: p.name })}</span>
          </button>
        );
      })}
    </div>
  );
}

export default CropPicker;
