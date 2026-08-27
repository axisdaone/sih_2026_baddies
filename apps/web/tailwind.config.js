/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand green (also the PWA theme colour).
        brand: {
          DEFAULT: '#166534',
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          400: '#4ade80',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
        },
        // Shelf-life status colours (fresh / warning / critical / spoiled). fresh/critical are the
        // 700 shades so white chip text and coloured text on white both clear WCAG AA (≥ 4.5:1);
        // warning stays amber-500 for fills (with dark text) — use text-amber-700 for amber text.
        fresh: '#15803d',
        warning: '#f59e0b',
        critical: '#c2410c',
        spoiled: '#b91c1c',
      },
      fontFamily: {
        // System fonts only: Noto Sans variants ship on Android and cover Devanagari + Tamil.
        sans: [
          '"Noto Sans"',
          '"Noto Sans Devanagari"',
          '"Noto Sans Tamil"',
          'Roboto',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          '"Nirmala UI"',
          'Latha',
          'Arial',
          'sans-serif',
        ],
      },
      minHeight: { touch: '3.5rem' },
      minWidth: { touch: '3.5rem' },
    },
  },
  plugins: [],
};
