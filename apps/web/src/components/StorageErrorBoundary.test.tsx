import { render, screen } from '@testing-library/react';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { isStorageError } from '../db/errors';

// Simulate Dexie failing to open (IndexedDB missing / blocked): every live query throws during render.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => {
    throw new Dexie.OpenFailedError('IndexedDB API missing. Please visit https://tinyurl.com/y2uuvskb');
  },
}));

import { useBatches } from '../hooks/useBatch';
import { StorageErrorBoundary } from './StorageErrorBoundary';

function HomeLike(): JSX.Element {
  const { batches } = useBatches();
  return <p>{batches.length}</p>;
}

function Boom(): JSX.Element {
  throw new Error('render exploded');
}

describe('isStorageError', () => {
  it('recognises Dexie / IndexedDB failure classes by name (incl. MissingAPIError) and wrapped inner errors', () => {
    expect(isStorageError(new Dexie.OpenFailedError('x'))).toBe(true);
    expect(isStorageError(new Dexie.MissingAPIError('IndexedDB API missing'))).toBe(true);
    expect(isStorageError(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))).toBe(true);
    expect(isStorageError(Object.assign(new Error('wrapped'), { inner: Object.assign(new Error('closed'), { name: 'DatabaseClosedError' }) }))).toBe(true);
    expect(isStorageError(new Error('plain'))).toBe(false);
    expect(isStorageError('string')).toBe(false);
  });
});

describe('StorageErrorBoundary', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('explains a storage failure thrown by a live query instead of a blank tree', () => {
    render(
      <StorageErrorBoundary>
        <HomeLike />
      </StorageErrorBoundary>,
    );
    const box = screen.getByTestId('storage-error');
    expect(box).toHaveTextContent('This browser is blocking local storage');
    expect(box).not.toHaveTextContent('tinyurl'); // never Dexie's raw English message
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the generic message for any other render error', () => {
    render(
      <StorageErrorBoundary>
        <Boom />
      </StorageErrorBoundary>,
    );
    expect(screen.getByTestId('render-error')).toHaveTextContent('Something went wrong.');
  });

  it('renders children when nothing throws', () => {
    render(
      <StorageErrorBoundary>
        <p>fine</p>
      </StorageErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});
