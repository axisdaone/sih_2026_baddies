/** Inline SVG crop pictograms (icon-first UI, works offline; no image assets to cache). */
import type { SVGProps } from 'react';
import type { Crop } from '../types';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Tomato({ size = 48, ...rest }: Props): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" {...rest}>
      <circle cx="32" cy="36" r="24" fill="#e53935" />
      <circle cx="24" cy="30" r="8" fill="#ef5350" opacity="0.7" />
      <path d="M32 14c-3-6-9-7-13-5 4 1 6 3 7 6-5-2-10 0-12 3 5-1 9 1 12 4-1-3 1-6 6-8z" fill="#2e7d32" />
      <path d="M32 14c3-6 9-7 13-5-4 1-6 3-7 6 5-2 10 0 12 3-5-1-9 1-12 4 1-3-1-6-6-8z" fill="#43a047" />
      <path d="M32 8v10" stroke="#2e7d32" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Guava({ size = 48, ...rest }: Props): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" {...rest}>
      <path d="M32 12c-14 0-22 10-22 24 0 12 9 20 22 20s22-8 22-20c0-14-8-24-22-24z" fill="#7cb342" />
      <path d="M32 16c-10 0-17 8-17 20 0 9 7 16 17 16s17-7 17-16c0-12-7-20-17-20z" fill="#9ccc65" />
      <ellipse cx="32" cy="38" rx="9" ry="10" fill="#f8bbd0" opacity="0.9" />
      <circle cx="29" cy="36" r="1.4" fill="#ad1457" />
      <circle cx="35" cy="40" r="1.4" fill="#ad1457" />
      <circle cx="33" cy="33" r="1.2" fill="#ad1457" />
      <path d="M32 12c2-4 6-6 10-5-3 1-5 3-6 6-2-1-3-1-4-1z" fill="#33691e" />
    </svg>
  );
}

function Generic({ size = 48, ...rest }: Props): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" {...rest}>
      <circle cx="32" cy="34" r="22" fill="#a5d6a7" />
      <path d="M32 12c-2-4-6-6-10-5 3 1 5 3 6 6 2-1 3-1 4-1z" fill="#2e7d32" />
    </svg>
  );
}

export function CropIcon({ crop, size = 48, ...rest }: { crop: Crop | string } & Props): JSX.Element {
  if (crop === 'tomato') return <Tomato size={size} {...rest} />;
  if (crop === 'guava') return <Guava size={size} {...rest} />;
  return <Generic size={size} {...rest} />;
}

export default CropIcon;
