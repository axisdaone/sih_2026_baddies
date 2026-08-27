/**
 * Error boundary for the routed page tree. When IndexedDB is unavailable (private mode, blocked site
 * data, quota / corruption) every Dexie live query rejects and dexie-react-hooks rethrows during
 * render, which would otherwise white-screen the whole app. Storage failures get a specific,
 * translated explanation; anything else gets the generic message. Both offer a reload.
 * Class component: React 18 has no hook form of componentDidCatch.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import { isStorageError } from '../db/errors';

interface Props extends WithTranslation {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

class StorageErrorBoundaryBase extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] render failed', error, info.componentStack);
  }

  private reload = (): void => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { t } = this.props;
    const storage = isStorageError(error);
    return (
      <div className="page" role="alert" data-testid={storage ? 'storage-error' : 'render-error'}>
        <section className="card mt-6 border-2 border-spoiled">
          <p className="text-lg font-bold">{storage ? t('storage_unavailable') : t('error_generic')}</p>
          {!storage && <p className="mt-1 break-words text-xs text-gray-500">{error.message}</p>}
          <button type="button" className="btn-primary mt-4 w-full" onClick={this.reload}>
            {t('retry')}
          </button>
        </section>
      </div>
    );
  }
}

export const StorageErrorBoundary = withTranslation('common')(StorageErrorBoundaryBase);

export default StorageErrorBoundary;
