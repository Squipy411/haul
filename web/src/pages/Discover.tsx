import { Download, Info, Play, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Job, MetaPreview, WatchProgress } from '../../../shared/types';
import { jobProgress } from '../../../shared/jobs';
import { SERVICE_NAMES } from '../../../shared/services';
import { api, preparePlay, rememberPreview } from '../api';
import { ListButton, TrailerButton } from '../components/Extras';
import { GetReady } from '../components/GetReady';
import { Hero } from '../components/Hero';
import { ErrorNote, Figure, PosterCard, join } from '../components/ui';
import { Link, bytes, duration, pad, speed, useAsync, usePolling } from '../lib';
import { useService } from '../shell';

const CATALOG_ID: Record<string, string> = { top: 'top', new: 'year', featured: 'imdbRating' };


function Transfers({ jobs }: { jobs: Job[] }) {
  const service = useService().name;
  const active = jobs.filter((job) => ['queued', 'torbox', 'downloading', 'paused'].includes(job.status));
  if (!active.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Downloading</h2>
        <Link to="/downloads">All downloads</Link>
      </div>
      <div className="transfer-list">
        {active.slice(0, 6).map((job) => {
          const progress = jobProgress(job);
          const total = job.files.reduce((sum, file) => sum + file.size, 0);
          const left = job.speed > 0 && total ? (total * (1 - progress.value)) / job.speed : 0;
          const label = job.label === 'Movie' ? null : job.label;
          return (
            <Link key={job.id} to={`/title/${job.type}/${job.imdbId}${job.season !== undefined ? `?season=${job.season}` : ''}`} className="transfer-row">
              <div className="thumb">{job.poster && <img src={job.poster} alt="" loading="lazy" />}</div>
              <div style={{ minWidth: 0 }}>
                <div className="name truncate">{job.title}</div>
                <div className="meta truncate">
                  {job.status === 'torbox' ? join([label, `${SERVICE_NAMES[job.torbox.service ?? 'torbox']} is fetching it, ${Math.round(progress.value * 100)}%`])
                    : job.status === 'queued' ? join([label, `Waiting for ${service}`])
                      : job.status === 'paused' ? join([label, 'Paused'])
                        : join([label, `${bytes(total * progress.value)} of ${bytes(total)}`, duration(left) ? `${duration(left)} left` : ''])}
                </div>
                <div className={`bar ${progress.remote ? 'remote' : ''}`}><i style={{ width: `${Math.round(progress.value * 100)}%` }} /></div>
              </div>
              <span className="rate">{job.status === 'downloading' && job.speed > 0 ? <span style={{ color: 'var(--accent)' }}>{speed(job.speed)}</span> : <Figure value={Math.round(progress.value * 100)} suffix="%" />}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** Episodes of your shows that are out but not in your library: watch now from your service, or fetch them. */
function NewEpisodes() {
  const { data } = useAsync(() => api.newEpisodes(), []);
  const shows = data?.shows ?? [];
  if (!shows.length) return null;
  return (
    <section className="watch-section">
      <div className="section-title"><h2>New episodes of your shows</h2><span className="faint num" style={{ fontSize: 13 }}>{shows.reduce((sum, show) => sum + show.episodes.length, 0)} out</span></div>
      <div className="shelf watch-shelf">
        {shows.slice(0, 12).map((show) => {
          const first = show.episodes[0]!;
          const watch = `/watch/series/${show.imdbId}?s=${show.season}&e=${first.episode}`;
          return (
            <div key={show.imdbId} className="watch-card">
              <Link to={watch} className="still" onPointerEnter={() => preparePlay({ type: 'series', imdbId: show.imdbId, season: show.season, episode: first.episode }, true)} aria-label={`Watch ${show.name} season ${show.season} episode ${first.episode}`}>
                {show.background && <img src={show.background} alt="" loading="lazy" />}
                <span className="play-badge"><Play size={18} fill="currentColor" /></span>
              </Link>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Link to={watch} style={{ minWidth: 0, flex: 1 }}>
                  <div className="name truncate">{show.name}</div>
                  <div className="meta truncate">{join([`S${pad(show.season)}E${pad(first.episode)}`, show.episodes.length > 1 ? `and ${show.episodes.length - 1} more` : first.title])}</div>
                </Link>
                <Link to={`/title/series/${show.imdbId}?season=${show.season}&get=new`} className="btn ghost sm icon" aria-label={`Download ${show.episodes.length} new episodes of ${show.name}`} title={`Download ${show.episodes.length}`}><Download size={14} /></Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const code = (item: WatchProgress) => (item.type === 'series' ? `S${pad(item.season!)}E${pad(item.episode!)}` : '');

/** Where you stopped, and the next episode of shows you're partway through. Hidden when empty. */
function ContinueWatching() {
  const { data, setData } = useAsync(() => api.continueWatching(), []);
  const items = data?.items ?? [];
  // The first one is what you're most likely to resume: get its stream ready.
  const first = items[0];
  useEffect(() => { if (first) preparePlay({ type: first.type, imdbId: first.imdbId, season: first.season, episode: first.episode }, true); }, [first]);
  if (!items.length) return null;
  const forget = async (item: WatchProgress) => {
    setData({ items: items.filter((entry) => entry.key !== item.key) });
    await api.forgetProgress(item.key).catch(() => undefined);
  };
  return (
    <section className="watch-section">
      <div className="section-title"><h2>Continue watching</h2></div>
      <div className="shelf watch-shelf">
        {items.map((item) => {
          const to = `/watch/${item.type}/${item.imdbId}${item.type === 'series' ? `?s=${item.season}&e=${item.episode}` : ''}`;
          const left = item.duration ? Math.max(1, Math.round((item.duration - item.position) / 60)) : 0;
          return (
            <div key={item.key} className="watch-card">
              <Link to={to} className="still" onPointerEnter={() => preparePlay({ type: item.type, imdbId: item.imdbId, season: item.season, episode: item.episode }, true)} aria-label={`${item.upNext ? 'Play' : 'Resume'} ${item.title} ${code(item)}`}>
                {(item.background || item.poster) && <img src={item.background || item.poster} alt="" loading="lazy" />}
                <span className="play-badge"><Play size={18} fill="currentColor" /></span>
                {!item.upNext && <i className="watched" aria-hidden="true"><b style={{ width: `${Math.min(100, (item.position / item.duration) * 100)}%` }} /></i>}
              </Link>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <Link to={to} style={{ minWidth: 0, flex: 1 }}>
                  <div className="name truncate">{item.title}</div>
                  <div className="meta truncate">{item.upNext ? `Up next · ${join([code(item), item.episodeTitle])}` : join([code(item), `${left} min left`])}</div>
                </Link>
                <button className="btn ghost sm icon" onClick={() => void forget(item)} aria-label={`Remove ${item.title} from Continue watching`}><X size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function when(released: string): string {
  const at = new Date(released);
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()) / 86_400_000);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** The next week of things you follow, and whether their torrents are out yet. Hidden when there's nothing. */
function ComingUp() {
  const { data } = useAsync(() => api.schedule(), []);
  const now = Date.now();
  const items = (data?.items ?? [])
    .filter((item) => item.followed && item.state !== 'owned' && item.state !== 'aired' && Date.parse(item.released) > now - 2 * 86_400_000 && Date.parse(item.released) < now + 7 * 86_400_000)
    .slice(0, 6);
  if (!items.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Coming up</h2>
        <Link to="/upcoming" className="faint" style={{ fontSize: 13 }}>See the schedule</Link>
      </div>
      <div className="new-ep-list">
        {items.map((item) => {
          const to = `/title/${item.type}/${item.imdbId}${item.season !== undefined ? `?season=${item.season}` : ''}`;
          return (
            <div key={`${item.imdbId}-${item.season}-${item.episode}`} className="new-ep">
              <Link to={to} className="still">{item.background && <img src={item.background} alt="" loading="lazy" />}</Link>
              <div style={{ minWidth: 0 }}>
                <Link to={to} className="name truncate" style={{ display: 'block' }}>{item.title}</Link>
                <div className="meta truncate">{join([item.type === 'movie' ? 'Movie' : `S${pad(item.season!)}E${pad(item.episode!)}`, item.type === 'movie' ? '' : when(item.released)])}</div>
              </div>
              {item.state === 'available' ? <span className="pill positive">Torrent out</span>
                : item.state === 'downloading' ? <span className="pill transfer">Downloading</span>
                  : item.state === 'searching' ? <span className="pill transfer">Looking</span>
                    : <span className="pill">Not out yet</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Popular titles with artwork, taking turns at the top of Home. */
function Featured({ rows, resume }: { rows: Array<{ id: string; items: MetaPreview[] }>; resume: WatchProgress[] }) {
  const picks = useMemo(() => {
    const shows = rows.find((row) => row.id === 'series-top')?.items ?? [];
    const movies = rows.find((row) => row.id === 'movie-top')?.items ?? [];
    const mixed: MetaPreview[] = [];
    for (let index = 0; index < 4; index += 1) for (const list of [shows, movies]) if (list[index]?.background) mixed.push(list[index]!);
    return mixed.slice(0, 6);
  }, [rows]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // A trailer playing over the page holds the banner still, so the title doesn't change under it.
  const [trailer, setTrailer] = useState(false);
  // Load the next backdrop ahead of time so the switch doesn't flash.
  useEffect(() => {
    const next = picks[(index + 1) % Math.max(1, picks.length)];
    if (next?.background) { const image = new Image(); image.decoding = 'async'; image.src = next.background; }
  }, [index, picks]);
  useEffect(() => {
    if (paused || trailer || picks.length < 2) return;
    const timer = window.setTimeout(() => setIndex((value) => (value + 1) % picks.length), 9000);
    return () => window.clearTimeout(timer);
  }, [index, paused, trailer, picks.length]);
  const item = picks[index % Math.max(1, picks.length)];
  // The full details (trailer, whether it's on My list) for the title showing; cached, so quick.
  const details = useAsync(() => (item ? api.meta(item.type, item.id).catch(() => null) : Promise.resolve(null)), [item?.type, item?.id]);
  if (!item) return null;
  const meta = details.data?.id === item.id ? details.data : null;
  const entry = resume.find((progress) => progress.imdbId === item.id && progress.type === item.type);
  const watch = item.type === 'series'
    ? `/watch/series/${item.id}?s=${entry?.season ?? 1}&e=${entry?.episode ?? 1}`
    : `/watch/movie/${item.id}`;
  return (
    <div onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <Hero
        key={item.id}
        background={item.background}
        logo={item.logo}
        title={item.name}
        facts={join([item.type === 'series' ? 'Series' : 'Movie', item.releaseInfo, (item.genres ?? []).slice(0, 3).join(', '), item.imdbRating && `IMDb ${item.imdbRating}`])}
        description={item.description}
        footer={picks.length > 1 && (
          <div className="hero-dots" role="tablist" aria-label="Featured">
            {picks.map((pick, position) => <button key={pick.id} role="tab" aria-selected={position === index} aria-label={pick.name} onClick={() => setIndex(position)} />)}
          </div>
        )}
      >
        <Link to={watch} className="btn primary lg" onPointerEnter={() => preparePlay({ type: item.type, imdbId: item.id, season: item.type === 'series' ? entry?.season ?? 1 : undefined, episode: item.type === 'series' ? entry?.episode ?? 1 : undefined }, true)}><Play size={17} fill="currentColor" />{entry && !entry.upNext ? 'Resume' : 'Play'}</Link>
        <Link to={`/title/${item.type}/${item.id}`} className="btn lg glass" onClick={() => rememberPreview(item)}><Info size={17} />More info</Link>
        {meta && <TrailerButton url={meta.trailer} title={item.name} className="btn lg glass" onOpenChange={setTrailer} />}
        {meta && <ListButton key={item.id} item={{ type: item.type, imdbId: item.id, title: item.name, poster: item.poster, background: item.background, releaseInfo: item.releaseInfo }} initial={Boolean(meta.inList)} className="btn lg glass hide-xs" />}
      </Hero>
    </div>
  );
}

/** Saved to watch later, newest first. Hidden when empty. */
function MyList() {
  const { data } = useAsync(() => api.watchlist(), []);
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <section>
      <div className="section-title"><h2>My list</h2><Link to="/library?tab=list" className="link">See all</Link></div>
      <div className="shelf">{items.slice(0, 20).map((item) => <PosterCard key={`${item.type}-${item.imdbId}`} item={{ id: item.imdbId, type: item.type, name: item.title, poster: item.poster, background: item.background, releaseInfo: item.releaseInfo }} />)}</div>
    </section>
  );
}

/** Your own shows and films, newest first. */
function YourLibrary() {
  const { data } = useAsync(() => api.library(), []);
  const items = (data?.items ?? []).filter((item) => item.imdbId).sort((a, b) => b.addedAt - a.addedAt);
  const row = (type: 'series' | 'movie', title: string) => {
    const list = items.filter((item) => item.type === type).slice(0, 20);
    if (!list.length) return null;
    return (
      <section>
        <div className="section-title"><h2>{title}</h2><Link to="/library" className="link">See all</Link></div>
        <div className="shelf">{list.map((item) => <PosterCard key={item.id} item={{ id: item.imdbId!, type: item.type, name: item.title, poster: item.poster, releaseInfo: item.year ? String(item.year) : undefined, inLibrary: false }} />)}</div>
      </section>
    );
  };
  return <>{row('series', 'Your shows')}{row('movie', 'Your movies')}</>;
}

export function Discover() {
  const { data, error, reload } = useAsync(() => api.home(), []);
  const resume = useAsync(() => api.continueWatching().catch(() => ({ items: [] as WatchProgress[] })), []);
  const downloads = useAsync(() => api.downloads(), []);
  // Every 2 seconds while something downloads, otherwise every 15.
  const busy = (downloads.data?.jobs ?? []).some((job) => ['queued', 'torbox', 'downloading'].includes(job.status));
  usePolling(() => { api.downloads().then(downloads.setData, () => undefined); }, busy ? 2000 : 15_000);
  return (
    <div className="canvas home">
      <h1 className="sr-only">Home</h1>
      {data ? <Featured rows={data.rows} resume={resume.data?.items ?? []} /> : !error && <div className="hero large skeleton-hero" />}
      <ContinueWatching />
      <div className="home-top">
        <GetReady />
        <Transfers jobs={downloads.data?.jobs ?? []} />
      </div>
      <MyList />
      <NewEpisodes />
      <YourLibrary />
      <div className="home-top">
        <ComingUp />
      </div>
      {error && <div style={{ marginTop: 20 }}><ErrorNote message={`The catalog didn't load: ${error}`} onRetry={reload} /></div>}
      {!data && !error && [0, 1].map((key) => (
        <section key={key}>
          <div className="section-title"><span className="skeleton" style={{ width: 160, height: 20 }} /></div>
          <div className="shelf">{Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton" style={{ aspectRatio: '2 / 3' }} />)}</div>
        </section>
      ))}
      {data?.rows.map((row) => {
        const [type, kind] = row.id.split('-');
        return (
          <section key={row.id}>
            <div className="section-title">
              <h2>{row.title}</h2>
              <Link to={`/browse/${type}/${CATALOG_ID[kind!] ?? 'top'}`} className="link">See all</Link>
            </div>
            <div className="shelf">{row.items.map((item) => <PosterCard key={item.id} item={item} />)}</div>
          </section>
        );
      })}
    </div>
  );
}
