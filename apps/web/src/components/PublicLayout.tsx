/** Layout for the public Quality Pass page: top bar only, no bottom nav, no sync/online chrome. */
import { Outlet } from 'react-router-dom';
import { TopBar } from './Layout';

export default function PublicLayout(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <TopBar showStatus={false} />
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
