// Vitest setup: in-memory IndexedDB for Dexie, jest-dom matchers, deterministic language.
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';

// Lazy (React.lazy) pages are transformed on first import; under a parallel run the default 1 s
// findBy* timeout is too tight, so give async queries more headroom (does not slow passing tests).
configure({ asyncUtilTimeout: 5_000 });

// The language detector reads localStorage; pin English so tests are stable regardless of the host OS.
try {
  localStorage.setItem('fs.lang', 'en');
} catch {
  /* ignore */
}
