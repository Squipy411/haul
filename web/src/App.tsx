import { Command } from 'cmdk';
import { CalendarDays, ChevronLeft, Download, House, Library as LibraryIcon, Search, Settings as SettingsIcon } from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { MetaPreview, Status } from '../../shared/types';
import { api } from './api';
import { Figure, Loading, Mark } from './components/ui';
import { Link, speed, usePolling, useRouter } from './lib';
import { CrumbContext, SearchContext } from './shell';
import { Browse } from './pages/Browse';
import { Discover } from './pages/Discover';
import { Downloads } from './pages/Downloads';
import { LibraryPage } from './pages/Library';
import { Login } from './pages/Login';
import { SettingsPage } from './pages/Settings';
import { Setup } from './pages/Setup';
import { TitlePage } from './pages/Title';
import { Upcoming } from './pages/Upcoming';

const NAV = [
  { to: '/', label: 'Home', icon: House, match: (path: string) => path === '/' || path.startsWith('/title') || path.startsWith('/browse') || path.startsWith('/search') },
  { to: '/upcoming', label: 'Upcoming', icon: CalendarDays, match: (path: string) => path.startsWith('/upcoming') },
  { to: '/downloads', label: 'Downloads', icon: Download, match: (path: string) => path.startsWith('/downloads') },
  { to: '/library', label: 'Library', icon: LibraryIcon, match: (path: string) => path.startsWith('/library') },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, match: (path: string) => path.startsWith('/settings') }
];

function Page({ path }: { path: string }) {
  const title = /^\/title\/(movie|series)\/(tt\d+)$/.exec(path);
  if (title) return <TitlePage key={path} type={title[1] as 'movie' | 'series'} id={title[2]!} />;
  const browse = /^\/browse\/(movie|series)\/(top|year|imdbRating)$/.exec(path);
  if (browse) return <Browse key={path} type={browse[1] as 'movie' | 'series'} catalog={browse[2]!} />;
  if (path.startsWith('/upcoming')) return <Upcoming />;
  if (path.startsWith('/downloads')) return <Downloads />;
  if (path.startsWith('/library')) return <LibraryPage />;
  if (path.startsWith('/settings')) return <SettingsPage />;
  return <Discover />;
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { navigate } = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (!open) { setQuery(''); setResults([]); } }, [open]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setResults([]); return; }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.search(text).then((found) => { if (alive) setResults([...found.series, ...found.movies].slice(0, 14)); }, () => undefined).finally(() => { if (alive) setLoading(false); });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [query]);

  const go = (to: string) => { onOpenChange(false); navigate(to); };
  const pages = NAV.filter((item) => !query || item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Search Haul" shouldFilter={false} overlayClassName="overlay" contentClassName="cmdk">
      <Command.Input value={query} onValueChange={setQuery} placeholder="Search films and shows, or type a page name" />
      <Command.List>
        {query.trim().length >= 2 && !loading && !results.length && !pages.length && <Command.Empty>Nothing found for “{query}”.</Command.Empty>}
        {results.length > 0 && (
          <Command.Group heading="Titles">
            {results.map((item) => (
              <Command.Item key={`${item.type}-${item.id}`} value={`${item.type}-${item.id}`} onSelect={() => go(`/title/${item.type}/${item.id}`)}>
                {item.poster ? <img src={item.poster} alt="" /> : <span style={{ width: 28 }} />}
                <span className="truncate">{item.name}</span>
                <span className="k">{item.type === 'series' ? 'Show' : 'Movie'}{item.releaseInfo ? ` · ${item.releaseInfo}` : ''}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {loading && <div className="loading" style={{ padding: '14px 10px' }}><span className="spinner" />Searching…</div>}
        {pages.length > 0 && (
          <Command.Group heading="Go to">
            {pages.map(({ to, label, icon: Icon }) => (
              <Command.Item key={to} value={`page-${to}`} onSelect={() => go(to)}><Icon size={16} />{label}</Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

function Shell({ status, children }: { status: Status; children: ReactNode }) {
  const { path, back } = useRouter();
  const [crumb, setCrumb] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((event.target as HTMLElement).tagName);
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const active = status.activeDownloads;
  return (
    <CrumbContext.Provider value={setCrumb}>
      <SearchContext.Provider value={openSearch}>
        <Tooltip.Provider>
          <aside className="sidebar">
            <Link to="/" className="wordmark"><Mark />Haul</Link>
            <nav className="nav" aria-label="Main">
              {NAV.map(({ to, label, icon: Icon, match }) => (
                <Link key={to} to={to} className={`nav-item ${match(path) ? 'active' : ''}`} aria-current={match(path) ? 'page' : undefined}>
                  <Icon size={16} strokeWidth={1.6} />
                  {label}
                  {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
                </Link>
              ))}
            </nav>
            <div className="side-foot">
              {status.update && <a href={status.update.url} target="_blank" rel="noreferrer">Haul {status.update.version} is out. Update ↗</a>}
              <span className="num">{status.libraryCounts.series} shows · {status.libraryCounts.movies} movies</span>
              <span>Haul {status.version}</span>
            </div>
          </aside>
          <div className="main">
            <header className="topbar">
              {crumb ? (
                <div className="crumb">
                  <button className="btn ghost sm" onClick={() => back('/')}><ChevronLeft size={16} />Back</button>
                  <span className="truncate">{crumb}</span>
                </div>
              ) : null}
              <button className="search-trigger" onClick={openSearch} aria-label="Search films and shows" style={crumb ? { marginLeft: 'auto', width: 240 } : undefined}>
                <Search size={15} />
                <span className="truncate">{crumb ? 'Search' : 'Search films and shows'}</span>
                <kbd>⌘K</kbd>
              </button>
              <div className="topbar-end" style={crumb ? { marginLeft: 0 } : undefined}>
                {active > 0 && (
                  <Link to="/downloads" className="transfer">
                    {status.transferSpeed > 0 ? <><b><Figure value={status.transferSpeed / 1_048_576} decimals={1} suffix=" MB/s" /></b> · </> : null}
                    {active} active
                  </Link>
                )}
                <div className="switcher" title={status.torboxConfigured ? 'TorBox account connected' : 'TorBox is not connected'}>
                  <span className={`dot ${status.torboxConfigured ? 'on' : 'off'}`} />
                  <span className="label">TorBox</span>
                </div>
              </div>
            </header>
            {children}
          </div>
          <nav className="bottombar" aria-label="Main">
            {NAV.map(({ to, label, icon: Icon, match }) => (
              <Link key={to} to={to} className={match(path) ? 'active' : ''}>
                <Icon size={20} strokeWidth={1.6} />
                {label}
                {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
              </Link>
            ))}
          </nav>
          <Palette open={searchOpen} onOpenChange={setSearchOpen} />
        </Tooltip.Provider>
      </SearchContext.Provider>
    </CrumbContext.Provider>
  );
}

export function App() {
  const { path, search, navigate } = useRouter();
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
  usePolling(refresh, 3000);

  // Old /search?q= links open the palette's results on Home instead.
  useEffect(() => { if (path.startsWith('/search')) navigate('/', { replace: true }); }, [path, search, navigate]);

  useEffect(() => {
    const active = status?.activeDownloads ?? 0;
    document.title = active ? `${speed(status?.transferSpeed) || `${active} active`} · Haul` : 'Haul';
  }, [status?.activeDownloads, status?.transferSpeed]);

  if (!status) {
    return failed
      ? <div className="gate"><div className="gate-card"><h1>Haul isn't responding</h1><p>The server may be restarting.</p><div><button className="btn primary" onClick={refresh}>Try again</button></div></div></div>
      : <Loading />;
  }
  if (status.needsPassword) return <Setup createPassword onDone={refresh} />;
  if (!status.authenticated) return <Login onDone={refresh} desktop={status.desktop} passwordSet={status.passwordSet} />;
  if (!status.setupComplete) return <Setup createPassword={false} onDone={refresh} />;

  return <Shell status={status}><Page path={path} /></Shell>;
}
