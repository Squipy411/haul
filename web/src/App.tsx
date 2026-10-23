import { Compass, Download, Library as LibraryIcon, Search, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Status } from '../../shared/types';
import { api } from './api';
import { Loading } from './components/ui';
import { Link, usePolling, useRouter } from './lib';
import { Browse } from './pages/Browse';
import { Discover } from './pages/Discover';
import { Downloads } from './pages/Downloads';
import { LibraryPage } from './pages/Library';
import { Login } from './pages/Login';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { Setup } from './pages/Setup';
import { TitlePage } from './pages/Title';

const NAV = [
  { to: '/', label: 'Discover', icon: Compass, match: (path: string) => path === '/' || path.startsWith('/title') || path.startsWith('/browse') },
  { to: '/search', label: 'Search', icon: Search, match: (path: string) => path.startsWith('/search') },
  { to: '/downloads', label: 'Downloads', icon: Download, match: (path: string) => path.startsWith('/downloads') },
  { to: '/library', label: 'Library', icon: LibraryIcon, match: (path: string) => path.startsWith('/library') },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: (path: string) => path.startsWith('/settings') }
];

function Page({ path }: { path: string }) {
  const title = /^\/title\/(movie|series)\/(tt\d+)$/.exec(path);
  if (title) return <TitlePage key={path} type={title[1] as 'movie' | 'series'} id={title[2]!} />;
  const browse = /^\/browse\/(movie|series)\/(top|year|imdbRating)$/.exec(path);
  if (browse) return <Browse key={path} type={browse[1] as 'movie' | 'series'} catalog={browse[2]!} />;
  if (path.startsWith('/search')) return <SearchPage />;
  if (path.startsWith('/downloads')) return <Downloads />;
  if (path.startsWith('/library')) return <LibraryPage />;
  if (path.startsWith('/settings')) return <SettingsPage />;
  return <Discover />;
}

export function App() {
  const { path } = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    api.status().then((value) => { setStatus(value); setFailed(false); }, () => setFailed(true));
  }, []);
  useEffect(() => {
    refresh();
    const onUnauthorized = () => refresh();
    window.addEventListener('haul:unauthorized', onUnauthorized);
    window.addEventListener('haul:refresh-status', onUnauthorized);
    return () => {
      window.removeEventListener('haul:unauthorized', onUnauthorized);
      window.removeEventListener('haul:refresh-status', onUnauthorized);
    };
  }, [refresh]);
  usePolling(refresh, 6000);

  useEffect(() => {
    const active = status?.activeDownloads ?? 0;
    document.title = active ? `(${active}) Haul` : 'Haul';
  }, [status?.activeDownloads]);

  if (!status) {
    return failed
      ? <div className="splash"><div className="splash-card"><h1>Can't reach Haul</h1><p className="muted">The Haul server isn't answering. It may be restarting.</p><button className="btn primary" onClick={refresh}>Try again</button></div></div>
      : <Loading />;
  }
  if (status.authRequired && !status.authenticated) return <Login onDone={refresh} />;
  if (!status.setupComplete) return <Setup onDone={refresh} />;

  const active = status.activeDownloads;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <div><strong>Haul</strong><span>TorBox media downloader</span></div>
        </div>
        {NAV.map(({ to, label, icon: Icon, match }) => (
          <Link key={to} to={to} className={`nav-item ${match(path) ? 'active' : ''}`}>
            <Icon size={18} />
            {label}
            {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
          </Link>
        ))}
        <div className="sidebar-foot">
          <div className="status-chip">
            <span className={`dot ${status.torboxConfigured ? 'good' : 'bad'}`} />
            <div className="grow">
              <b>{status.torboxConfigured ? 'TorBox connected' : 'TorBox not set up'}</b>
              <div className="faint" style={{ fontSize: 11.5 }}>
                {status.libraryCounts.movies} movies · {status.libraryCounts.series} shows
              </div>
            </div>
          </div>
          <div className="faint" style={{ fontSize: 11, padding: '0 6px' }}>Haul v{status.version}</div>
        </div>
      </aside>
      <main className="main">
        <Page path={path} />
      </main>
      <nav className="tabbar">
        {NAV.map(({ to, label, icon: Icon, match }) => (
          <Link key={to} to={to} className={match(path) ? 'active' : ''}>
            <Icon size={21} />
            {label}
            {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
          </Link>
        ))}
      </nav>
    </div>
  );
}
