import { Compass, Download, Library as LibraryIcon, Search, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

function TopSearch() {
  const { navigate, path, search } = useRouter();
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!path.startsWith('/search')) setValue(''); else setValue(search.get('q') ?? ''); }, [path, search]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === '/' && !/input|textarea/i.test(target.tagName)) { event.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <form className="top-search" onSubmit={(event) => { event.preventDefault(); if (value.trim()) navigate(`/search?q=${encodeURIComponent(value.trim())}`); }}>
      <input ref={input} value={value} onChange={(event) => setValue(event.target.value)} placeholder="Search movies and shows" aria-label="Search" />
      <kbd>/</kbd>
    </form>
  );
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
    window.addEventListener('haul:unauthorized', refresh);
    window.addEventListener('haul:refresh-status', refresh);
    return () => {
      window.removeEventListener('haul:unauthorized', refresh);
      window.removeEventListener('haul:refresh-status', refresh);
    };
  }, [refresh]);
  usePolling(refresh, 5000);

  useEffect(() => {
    const active = status?.activeDownloads ?? 0;
    document.title = active ? `Haul (${active})` : 'Haul';
  }, [status?.activeDownloads]);

  if (!status) {
    return failed
      ? <div className="gate"><div className="gate-inner"><h1>Haul isn't answering</h1><p className="muted">The server may be restarting.</p><div><button className="btn" onClick={refresh}>Try again</button></div></div></div>
      : <Loading />;
  }
  if (status.authRequired && !status.authenticated) return <Login onDone={refresh} />;
  if (!status.setupComplete) return <Setup onDone={refresh} />;

  const active = status.activeDownloads;
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand"><img src="/icon.svg" alt="" />HAUL</Link>
        <nav className="nav">
          {NAV.map(({ to, label, match }) => (
            <Link key={to} to={to} className={match(path) ? 'active' : ''}>
              {label}
              {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <TopSearch />
          <div className="readout" title={status.torboxConfigured ? 'TorBox connected' : 'TorBox not connected'}>
            <span className={`sq ${status.torboxConfigured ? 'ok' : 'bad'}`} />
            <span className="hide-sm">TORBOX</span>
          </div>
        </div>
      </header>
      <main><Page path={path} /></main>
      <nav className="bottombar">
        {[NAV[0]!, { to: '/search', label: 'Search', icon: Search, match: (value: string) => value.startsWith('/search') }, ...NAV.slice(1)].map(({ to, label, icon: Icon, match }) => (
          <Link key={to} to={to} className={match(path) ? 'active' : ''}>
            <Icon size={19} strokeWidth={1.75} />
            {label}
            {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
          </Link>
        ))}
      </nav>
    </>
  );
}
