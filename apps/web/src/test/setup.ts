// Vitest setup: in-memory IndexedDB for Dexie, jest-dom matchers, deterministic language.
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

// The language detector reads localStorage; pin English so tests are stable regardless of the host OS.
try {
  localStorage.setItem('fs.lang', 'en');
} catch {
  /* ignore */
}
