#!/usr/bin/env node
/**
 * Critical-path size gate (NFR performance: "< 300 KB critical path", read as transferred bytes).
 * Runs as `postbuild` (so `npm run build` — locally and in the CI web job — fails when the entry
 * chunk + vendor chunk + main stylesheet exceed the budget). Page chunks (Home, Leaflet, QR…) are
 * lazy and not counted. The entry chunk carries all 18 locale catalogues (~106 KB raw, mostly
 * Devanagari/Tamil text that gzips ~5:1), so the raw budget is looser than the gzip one.
 * Override with FS_SIZE_BUDGET_RAW / FS_SIZE_BUDGET_GZIP (bytes).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const ASSETS = join(DIST, 'assets');
const BUDGET_RAW = Number(process.env.FS_SIZE_BUDGET_RAW ?? 512 * 1024);
const BUDGET_GZIP = Number(process.env.FS_SIZE_BUDGET_GZIP ?? 160 * 1024);

/** Critical path = index.html + the entry script + the shared vendor chunk + the main stylesheet. */
const CRITICAL = [/^index-[\w-]+\.js$/, /^vendor-[\w-]+\.js$/, /^index-[\w-]+\.css$/];

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

let files;
try {
  files = readdirSync(ASSETS);
} catch {
  console.error(`[size] dist/assets not found (${ASSETS}); run \`vite build\` first.`);
  process.exit(1);
}

const picked = files.filter((f) => CRITICAL.some((re) => re.test(f)));
if (picked.length === 0) {
  console.error('[size] no critical-path assets matched; check the chunk naming in vite.config.ts');
  process.exit(1);
}
let raw = 0;
let gz = 0;
const rows = [];
for (const name of ['index.html', ...picked]) {
  const path = name === 'index.html' ? join(DIST, name) : join(ASSETS, name);
  const bytes = readFileSync(path);
  const size = statSync(path).size;
  const gsize = gzipSync(bytes, { level: 9 }).length;
  raw += size;
  gz += gsize;
  rows.push(`  ${name.padEnd(34)} ${kb(size).padStart(10)} raw ${kb(gsize).padStart(10)} gzip`);
}
console.log('[size] critical path:');
console.log(rows.join('\n'));
console.log(`  ${'total'.padEnd(34)} ${kb(raw).padStart(10)} raw ${kb(gz).padStart(10)} gzip  (budget ${kb(BUDGET_RAW)} raw / ${kb(BUDGET_GZIP)} gzip)`);

if (raw > BUDGET_RAW || gz > BUDGET_GZIP) {
  console.error(`[size] FAIL: critical path exceeds the budget (${kb(raw)} raw / ${kb(gz)} gzip).`);
  process.exit(1);
}
console.log('[size] OK');
