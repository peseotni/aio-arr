import { useEffect, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { onUnauthorized } from './lib/api';
import { useAuthState } from './lib/queries';
import { matchPath, useRouter } from './lib/router';
import { AppShell } from './components/layout';
import { MediaProvider } from './components/media';
import { MediaDetailModal } from './components/detail';
import { Spinner } from './components/ui';
import { LoginPage, SetupPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { ForYouPage } from './pages/ForYou';
import { SearchPage } from './pages/Search';
import { LibraryPage } from './pages/Library';
import { DownloadsPage } from './pages/Downloads';
import { CalendarPage } from './pages/Calendar';
import { WantedPage } from './pages/Wanted';
import { FilesPage } from './pages/Files';
import { SystemPage } from './pages/System';
import { SettingsPage } from './pages/Settings';

const ROUTES: [string, () => ReactElement][] = [
  ['/', () => <HomePage />],
  ['/for-you', () => <ForYouPage />],
  ['/search', () => <SearchPage />],
  ['/movies', () => <LibraryPage key="movie" kind="movie" />],
  ['/tv', () => <LibraryPage key="series" kind="series" />],
  ['/music', () => <LibraryPage key="artist" kind="artist" />],
  ['/books', () => <LibraryPage key="book" kind="book" />],
  ['/downloads', () => <DownloadsPage />],
  ['/calendar', () => <CalendarPage />],
  ['/wanted', () => <WantedPage />],
  ['/files', () => <FilesPage />],
  ['/system', () => <SystemPage />],
  ['/settings', () => <SettingsPage />],
];

function Routes() {
  const { path } = useRouter();
  const hit = ROUTES.find(([pattern]) => matchPath(pattern, path));
  useEffect(() => {
    const titles: Record<string, string> = { '/': 'Home', '/tv': 'TV Shows', '/for-you': 'For you' };
    const name = titles[path] || path.slice(1).replace(/^\w/, (c) => c.toUpperCase());
    document.title = `${name} · AIO Arr`;
  }, [path]);
  return hit ? hit[1]() : <HomePage />;
}

export function App() {
  const { data: auth, isLoading, error } = useAuthState();
  const qc = useQueryClient();
  useEffect(() => onUnauthorized(() => void qc.invalidateQueries({ queryKey: ['auth'] })), [qc]);

  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-8" />
      </div>
    );
  }
  if (error || !auth) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center text-sm text-muted">
        Cannot reach the AIO Arr server. Is it running?
      </div>
    );
  }
  if (auth.setupRequired) return <SetupPage auth={auth} />;
  if (!auth.authenticated) return <LoginPage auth={auth} />;

  return (
    <MediaProvider renderDetail={(item, close) => <MediaDetailModal item={item} onClose={close} />}>
      <AppShell>
        <Routes />
      </AppShell>
    </MediaProvider>
  );
}
