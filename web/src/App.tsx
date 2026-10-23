import { Command } from 'cmdk';
import { CalendarDays, ChevronLeft, Download, Ellipsis, Film, House, Library as LibraryIcon, PanelLeftClose, PanelLeftOpen, Search, Settings as SettingsIcon, Tv } from 'lucide-react';
import { DropdownMenu, Tooltip } from 'radix-ui';
import { type ReactNode, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MetaPreview, Status } from '../../shared/types';
import { api } from './api';
import { HoverPreviewLayer } from './components/HoverPreview';
import { Avatar, ProfileMenu, ProfilePicker } from './components/Profiles';
import { Figure, Loading, Mark } from './components/ui';
import { Link, bytes, count, speed, usePolling, useRouter } from './lib';
import { CrumbContext, SearchContext, StatusContext, setTransferTitle, usePageTitle } from './shell';
import { Discover } from './pages/Discover';

// Home ships with the app; every other page is its own file, fetched in the background once the app is idle.
const pages = {
  browse: () => import('./pages/Browse'),
  downloads: () => import('./pages/Downloads'),
  library: () => import('./pages/Library'),
  login: () => import('./pages/Login'),
  settings: () => import('./pages/Settings'),
  setup: () => import('./pages/Setup'),
  title: () => import('./pages/Title'),
  upcoming: () => import('./pages/Upcoming'),
  watch: () => import('./pages/Watch')
};
const Browse = lazy(() => pages.browse().then((module) => ({ default: module.Browse })));
const Downloads = lazy(() => pages.downloads().then((module) => ({ default: module.Downloads })));
const LibraryPage = lazy(() => pages.library().then((module) => ({ default: module.LibraryPage })));
const Login = lazy(() => pages.login().then((module) => ({ default: module.Login })));
const SettingsPage = lazy(() => pages.settings().then((module) => ({ default: module.SettingsPage })));
const Setup = lazy(() => pages.setup().then((module) => ({ default: module.Setup })));
const TitlePage = lazy(() => pages.title().then((module) => ({ default: module.TitlePage })));
const Upcoming = lazy(() => pages.upcoming().then((module) => ({ default: module.Upcoming })));
const Watch = lazy(() => pages.watch().then((module) => ({ default: module.Watch })));

function prefetchPages(): void {
  const load = () => {
    for (const page of [pages.title, pages.watch, pages.downloads, pages.upcoming, pages.library, pages.settings, pages.browse]) void page().catch(() => undefined);
    // The stream player too, so the first press of play doesn't wait for it.
    void import('hls.js/light').catch(() => undefined);
  };
  // Later rather than sooner: the page being opened (above all the player) comes first.
  const later = () => { if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 6000 }); else load(); };
  setTimeout(later, window.location.pathname.startsWith('/watch/') ? 15_000 : 2500);
}

/** Watching comes first; the second group manages downloads and the app. On a phone the second group sits behind More. */
const NAV = [
  { to: '/', label: 'Home', short: 'Home', icon: House, group: 'watch', match: (path: string) => path === '/' || path.startsWith('/title') || path.startsWith('/search') },
  { to: '/browse/series/top', label: 'Shows', short: 'Shows', icon: Tv, group: 'watch', match: (path: string) => path.startsWith('/browse/series') },
  { to: '/browse/movie/top', label: 'Movies', short: 'Movies', icon: Film, group: 'watch', match: (path: string) => path.startsWith('/browse/movie') },
  { to: '/library', label: 'My library', short: 'Library', icon: LibraryIcon, group: 'watch', match: (path: string) => path.startsWith('/library') },
  { to: '/upcoming', label: 'Upcoming', short: 'Upcoming', icon: CalendarDays, group: 'manage', match: (path: string) => path.startsWith('/upcoming') },
  { to: '/downloads', label: 'Downloads', short: 'Downloads', icon: Download, group: 'manage', match: (path: string) => path.startsWith('/downloads') },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: SettingsIcon, group: 'manage', match: (path: string) => path.startsWith('/settings') }
] as const;

function Page({ path }: { path: string }) {
  const title = /^\/title\/(movie|series)\/(tt\d+)$/.exec(path);
  if (title) return <TitlePage key={path} type={title[1] as 'movie' | 'series'} id={title[2]!} />;
  const browse = /^\/browse\/(movie|series)\/(top|year|imdbRating)$/.exec(path);
  if (browse) return <Browse key={path} type={browse[1] as 'movie' | 'series'} catalog={browse[2]!} />;
  if (path.startsWith('/upcoming')) return <Upcoming />;
  if (path.startsWith('/downloads')) return <Downloads />;
  if (path.startsWith('/library')) return <LibraryPage />;
  if (path.startsWith('/settings')) return <SettingsPage />;
  if (path === '/' || path === '/index.html') return <Discover />;
  return <NotFound />;
}

function NotFound() {
  usePageTitle('Not found');
  return (
    <div className="canvas">
      <div className="gate-card" style={{ margin: '12vh auto 0' }}>
        <h1>There's nothing here</h1>
        <p>The link may be old, or the page may have moved.</p>
        <div className="row"><Link to="/" className="btn primary">Go home</Link></div>
      </div>
    </div>
  );
}

/** Free space on the fullest library disk, with every disk in the tooltip. */
function DiskMeter({ status }: { status: Status }) {
  const disks = status.disks ?? [];
  if (!disks.length) return null;
  const tightest = disks.reduce((low, disk) => (disk.free / disk.total < low.free / low.total ? disk : low));
  const used = tightest.total ? 1 - tightest.free / tightest.total : 0;
  const detail = disks.map((disk) => `${disk.labels.join(', ')}: ${bytes(disk.free)} free of ${bytes(disk.total)}`).join('\n');
  return (
    <div className={`disk-meter ${tightest.free < 20 * 1024 ** 3 ? 'low' : ''}`} title={detail}>
      <span className="num">{bytes(tightest.free)} free{disks.length > 1 ? ` on ${tightest.labels[0]!.toLowerCase()}` : ''}</span>
      <i aria-hidden="true"><b style={{ width: `${Math.round(used * 100)}%` }} /></i>
    </div>
  );
}

/** The download furthest along, with its progress, so it's in view from every page. */
function NowDownloading({ status }: { status: Status }) {
  const job = status.nowDownloading;
  if (!job) return null;
  const more = status.activeDownloads - 1;
  const percent = Math.round(job.progress * 100);
  return (
    <Link to="/downloads" className="side-download" title={`${job.title}: ${percent}%`}>
      <span className="side-download-thumb">{job.poster && <img src={job.poster} alt="" />}</span>
      <span className="side-download-text">
        <span className="row" style={{ gap: 6 }}><b className="truncate grow">{job.title}</b>{more > 0 && <span className="side-download-more num" title={`${more} more downloading`}>+{more}</span>}</span>
        <span className="faint truncate num">{job.remote ? `At TorBox · ${percent}%` : job.speed > 0 ? `${percent}% · ${speed(job.speed)}` : `${percent}%`}</span>
      </span>
      <span className={`side-download-bar ${job.remote ? 'remote' : ''}`}><i style={{ width: `${percent}%` }} /></span>
    </Link>
  );
}

function readCollapsed(): boolean {
  try { return localStorage.getItem('haul.sidebar') === 'collapsed'; } catch { return false; }
}

/** Two groups with a highlight that slides to the page you're on; folds down to icons. */
function Sidebar({ status, path }: { status: Status; path: string }) {
  const { navigate } = useRouter();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);
  const active = status.activeDownloads;

  useEffect(() => {
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'open';
    try { localStorage.setItem('haul.sidebar', collapsed ? 'collapsed' : 'open'); } catch { /* storage blocked */ }
  }, [collapsed]);
  useLayoutEffect(() => {
    const item = nav.current?.querySelector<HTMLElement>('.nav-item.active');
    setPill(item ? { top: item.offsetTop, height: item.offsetHeight } : null);
  }, [path, collapsed]);

  const groups = [
    { id: 'watch', label: 'Watch' },
    { id: 'manage', label: 'Manage' }
  ] as const;
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <Link to="/" className="wordmark" aria-label="Haul, TorBox player"><Mark size={26} /><span className="lockup"><b>Haul</b><small>TorBox player</small></span></Link>
      <nav className="nav" aria-label="Main" ref={nav}>
        {pill && <span className="nav-pill" aria-hidden="true" style={{ transform: `translateY(${pill.top}px)`, height: pill.height }} />}
        {groups.map((group) => (
          <div key={group.id} className="nav-group">
            <div className="nav-label">{group.label}</div>
            {NAV.filter((item) => item.group === group.id).map(({ to, label, icon: Icon, match }) => (
              <Tooltip.Root key={to} delayDuration={150}>
                <Tooltip.Trigger asChild>
                  <Link to={to} className={`nav-item ${match(path) ? 'active' : ''}`} aria-current={match(path) ? 'page' : undefined} aria-label={collapsed ? label : undefined}>
                    <Icon size={16} strokeWidth={1.6} />
                    <span className="nav-text">{label}</span>
                    {to === '/downloads' && active > 0 && <span className="count">{active}</span>}
                  </Link>
                </Tooltip.Trigger>
                {collapsed && <Tooltip.Portal><Tooltip.Content className="tooltip" side="right" sideOffset={10}>{label}</Tooltip.Content></Tooltip.Portal>}
              </Tooltip.Root>
            ))}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        {status.update && <a className="side-update" href={status.update.url} target="_blank" rel="noreferrer">Haul {status.update.version} is out. Update ↗</a>}
        <NowDownloading status={status} />
        <DiskMeter status={status} />
        <div className="side-me">
          {status.profile && (
            <ProfileMenu profiles={status.profiles} current={status.profile} onManage={() => navigate('/settings#profiles')} side="top">
              <button className="side-profile" aria-label={`Profile: ${status.profile.name}. Switch profile`}>
                <Avatar profile={status.profile} size={28} />
                <span className="side-profile-text">
                  <b className="truncate">{status.profile.name}</b>
                  <span className="faint truncate">{status.profiles.length > 1 ? 'Switch profile' : 'Your profile'}</span>
                </span>
              </button>
            </ProfileMenu>
          )}
          <button className="side-collapse" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.6} /> : <PanelLeftClose size={16} strokeWidth={1.6} />}
          </button>
        </div>
        <span className="side-version num"><span className="truncate">{count(status.libraryCounts.series, 'show')} · {count(status.libraryCounts.movies, 'movie')}</span><span>{status.version}</span></span>
      </div>
    </aside>
  );
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
  const { path, back, navigate } = useRouter();
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
  usePageTitle(crumb ?? NAV.find((item) => item.to !== '/' && item.match(path))?.label ?? null);
  return (
    <StatusContext.Provider value={status}>
    <CrumbContext.Provider value={setCrumb}>
      <SearchContext.Provider value={openSearch}>
        <Tooltip.Provider>
          <Sidebar status={status} path={path} />
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
                <div className="switcher" title={status.torboxRefused ? "TorBox didn't accept your API key" : status.torboxConfigured ? 'TorBox account connected' : 'TorBox is not connected'}>
                  <span className={`dot ${status.torboxConfigured && !status.torboxRefused ? 'on' : 'off'}`} />
                  <span className="label">TorBox</span>
                </div>
                {status.profile && <ProfileMenu profiles={status.profiles} current={status.profile} onManage={() => navigate('/settings#profiles')} />}
              </div>
            </header>
            {status.torboxRefused && !path.startsWith('/settings') && (
              <div className="key-banner notice negative" role="alert">
                TorBox didn't accept your API key, so streams and downloads can't start. It may have been reset.
                <Link to="/settings">Paste a new key in Settings</Link>
              </div>
            )}
            {children}
          </div>
          <nav className="bottombar" aria-label="Main">
            {NAV.filter((item) => item.group === 'watch').map(({ to, short, icon: Icon, match }) => (
              <Link key={to} to={to} className={match(path) ? 'active' : ''}>
                <Icon size={20} strokeWidth={1.6} />
                {short}
              </Link>
            ))}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className={NAV.some((item) => item.group === 'manage' && item.match(path)) ? 'active' : ''} aria-label="More">
                  <Ellipsis size={20} strokeWidth={1.6} />
                  More
                  {active > 0 && <span className="count">{active}</span>}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="popover" side="top" align="end" sideOffset={8}>
                  {NAV.filter((item) => item.group === 'manage').map(({ to, label, icon: Icon }) => (
                    <DropdownMenu.Item key={to} className="popover-item" onSelect={() => navigate(to)}>
                      <span className="row" style={{ gap: 10 }}><Icon size={16} strokeWidth={1.6} />{label}</span>
                      {to === '/downloads' && active > 0 && <span className="num faint">{active}</span>}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </nav>
          <Palette open={searchOpen} onOpenChange={setSearchOpen} />
          <HoverPreviewLayer />
        </Tooltip.Provider>
      </SearchContext.Provider>
    </CrumbContext.Provider>
    </StatusContext.Provider>
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
  useEffect(() => { if (status?.authenticated && status.setupComplete) prefetchPages(); }, [status?.authenticated, status?.setupComplete]);

  // Old /search?q= links open the palette's results on Home instead.
  useEffect(() => { if (path.startsWith('/search')) navigate('/', { replace: true }); }, [path, search, navigate]);

  useEffect(() => {
    const active = status?.activeDownloads ?? 0;
    setTransferTitle(active ? speed(status?.transferSpeed) || `${active} active` : '');
  }, [status?.activeDownloads, status?.transferSpeed]);

  if (!status) {
    return failed
      ? <div className="gate"><div className="gate-card"><h1>Haul isn't responding</h1><p>The server may be restarting.</p><div><button className="btn primary" onClick={refresh}>Try again</button></div></div></div>
      : <Loading />;
  }
  if (status.needsPassword) return <Suspense fallback={<Loading />}><Setup createPassword onDone={refresh} /></Suspense>;
  if (!status.authenticated) return <Suspense fallback={<Loading />}><Login onDone={refresh} desktop={status.desktop} passwordSet={status.passwordSet} twoFactor={status.twoFactor} /></Suspense>;
  if (!status.setupComplete) return <Suspense fallback={<Loading />}><Setup createPassword={false} onDone={refresh} /></Suspense>;

  // A house with more than one profile is asked who's watching, once per browser.
  if (status.profiles.length > 1 && !status.profileChosen) return <ProfilePicker profiles={status.profiles} />;

  // The player takes the whole screen, without the sidebar.
  const watch = /^\/watch\/(movie|series)\/(tt\d+)$/.exec(path);
  if (watch) return <Suspense fallback={<div className="player waiting" />}><Watch key={path} type={watch[1] as 'movie' | 'series'} id={watch[2]!} /></Suspense>;
  return <Shell status={status}><Suspense fallback={<Loading />}><Page path={path} /></Suspense></Shell>;
}
