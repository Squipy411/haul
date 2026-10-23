import type { Job } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Figure, PosterCard, join } from '../components/ui';
import { Link, airDate, bytes, duration, episodeRange, speed, useAsync, usePolling } from '../lib';
import { useOpenSearch } from '../shell';

const CATALOG_ID: Record<string, string> = { top: 'top', new: 'year', featured: 'imdbRating' };

function jobProgress(job: Job): { value: number; remote: boolean } {
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  if (job.files.length && total) return { value: job.files.reduce((sum, file) => sum + Math.min(file.downloaded, file.size), 0) / total, remote: false };
  return { value: job.torbox.progress ?? 0, remote: true };
}

function Transfers({ jobs }: { jobs: Job[] }) {
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
                  {job.status === 'torbox' ? join([label, `TorBox is fetching it, ${Math.round(progress.value * 100)}%`])
                    : job.status === 'queued' ? join([label, 'Waiting for TorBox'])
                      : job.status === 'paused' ? join([label, 'Paused'])
                        : join([label, `${bytes(total * progress.value)} of ${bytes(total)}`, left ? `${duration(left)} left` : ''])}
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

function NewEpisodes() {
  const { data, error } = useAsync(() => api.newEpisodes(), []);
  const shows = data?.shows ?? [];
  return (
    <section className="card">
      <div className="card-head">
        <h2>New episodes of your shows</h2>
        {shows.length > 0 && <span className="faint num" style={{ fontSize: 13 }}>{shows.reduce((sum, show) => sum + show.episodes.length, 0)} out</span>}
      </div>
      {!data && !error && <div className="skeleton" style={{ height: 120 }} />}
      {error && <div className="notice">Couldn't check for new episodes right now.</div>}
      {data && !shows.length && (
        <div className="empty" style={{ padding: '6px 0' }}>
          <b>You're up to date</b>
          When a show in your library gets a new episode, it appears here.
        </div>
      )}
      <div className="new-ep-list">
      {shows.slice(0, 6).map((show) => (
        <div key={show.imdbId} className="new-ep">
          <Link to={`/title/series/${show.imdbId}?season=${show.season}`} className="still">{show.background && <img src={show.background} alt="" loading="lazy" />}</Link>
          <div style={{ minWidth: 0 }}>
            <Link to={`/title/series/${show.imdbId}?season=${show.season}`} className="name truncate" style={{ display: 'block' }}>{show.name}</Link>
            <div className="meta truncate">
              {join([`Season ${show.season}`, show.episodes.length === 1 ? `Episode ${show.episodes[0]!.episode}` : episodeRange(show.episodes.map((episode) => episode.episode)), show.latest && `latest ${airDate(show.latest)}`])}
            </div>
          </div>
          <Link to={`/title/series/${show.imdbId}?season=${show.season}&get=new`} className="btn sm">Get {show.episodes.length}</Link>
        </div>
      ))}
      </div>
    </section>
  );
}

export function Discover() {
  const openSearch = useOpenSearch();
  const { data, error, reload } = useAsync(() => api.home(), []);
  const downloads = useAsync(() => api.downloads(), []);
  usePolling(() => { api.downloads().then(downloads.setData, () => undefined); }, 2000);
  const activeCount = (downloads.data?.jobs ?? []).filter((job) => ['queued', 'torbox', 'downloading', 'paused'].includes(job.status)).length;
  return (
    <div className="canvas">
      <div className="title-row">
        <div>
          <h1>Home</h1>
          <div className="sub">{activeCount ? `${activeCount} download${activeCount === 1 ? '' : 's'} in progress.` : 'Nothing downloading right now.'} Choose a show or a movie, and TorBox fetches it for you.</div>
        </div>
        <button className="btn primary" onClick={openSearch}>Find a title</button>
      </div>
      <div className="home-top">
        <Transfers jobs={downloads.data?.jobs ?? []} />
        <NewEpisodes />
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
