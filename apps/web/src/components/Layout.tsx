/**
 * App shell: top bar (app name, connectivity, pending-sync badge) + icon-first bottom nav.
 * Used for every route except the public Quality Pass page (see PublicLayout).
 */
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStatus } from '../state/appStatus';
import { OfflineIndicator } from './OfflineIndicator';
import { GearIcon, GroupIcon, HomeIcon, LeafIcon, PlusIcon } from './NavIcons';

interface NavItem {
  to: string;
  labelKey: 'nav.home' | 'nav.new' | 'nav.fpo' | 'nav.settings';
  Icon: typeof HomeIcon;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.home', Icon: HomeIcon, end: true },
  { to: '/new', labelKey: 'nav.new', Icon: PlusIcon },
  { to: '/fpo', labelKey: 'nav.fpo', Icon: GroupIcon },
  { to: '/settings', labelKey: 'nav.settings', Icon: GearIcon },
];

export function TopBar({ showStatus = true }: { showStatus?: boolean }): JSX.Element {
  const { t } = useTranslation('common');
  const { online, pendingOps } = useAppStatus();
  return (
    <header className="sticky top-0 z-40 border-b border-brand-700 bg-brand text-white shadow-sm">
      <div className="mx-auto flex h-14 w-full max-w-lg items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <LeafIcon width={24} height={24} />
          <span className="text-lg font-bold tracking-tight">{t('app_name')}</span>
        </div>
        {showStatus && (
          <div className="flex items-center gap-2">
            {pendingOps > 0 && (
              <span
                className="chip bg-amber-300 text-amber-950"
                aria-label={t('pending_changes', { count: pendingOps })}
                title={online ? t('syncing') : t('pending_changes', { count: pendingOps })}
              >
                {pendingOps}
              </span>
            )}
            <OfflineIndicator className="bg-white/90" />
          </div>
        )}
      </div>
    </header>
  );
}

export function BottomNav(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white pb-safe"
      style={{ height: 'calc(var(--fs-nav-h) + var(--fs-safe-bottom))' }}
    >
      <ul className="mx-auto grid h-16 w-full max-w-lg grid-cols-4">
        {NAV_ITEMS.map(({ to, labelKey, Icon, end }) => (
          <li key={to} className="flex">
            <NavLink
              to={to}
              end={end}
              aria-label={t(labelKey)}
              className={({ isActive }) =>
                `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold leading-tight ${
                  isActive ? 'text-brand' : 'text-gray-500 hover:text-gray-800'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon strokeWidth={isActive ? 2.5 : 2} />
                  <span>{t(labelKey)}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Default layout with bottom nav. */
export default function Layout(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <TopBar />
      <main className="flex-1">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
