import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { Job } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Figure, Loading, Menu, type MenuAction, TabBar, join } from '../components/ui';
import { Link, ago, bytes, duration, speed, useAsync, usePolling, useToast } from '../lib';
import { useOpenSearch, useService } from '../shell';
import { SERVICE_NAMES } from '../../../shared/services';

type Tab = 'active' | 'done' | 'stopped';

const ACTIVE = new Set(['queued', 'torbox', 'downloading', 'paused']);
const RES: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD' };

function sizes(job: Job) {
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  const done = job.files.reduce((sum, file) => sum + Math.min(file.downloaded, file.size), 0);
  const videos = job.files.filter((file) => file.kind === 'video');
  return { total, done, videos: videos.length, videosDone: videos.filter((file) => file.status === 'done' || file.status === 'skipped').length };
}

function progressOf(job: Job): { value: number; remote: boolean } {
  if (job.status === 'completed') return { value: 1, remote: false };
  const { total, done } = sizes(job);
  if (job.files.length && total) return { value: done / total, remote: false };
  return { value: job.status === 'queued' ? 0 : job.torbox.progress ?? 0, remote: true };
}

function StatusPill({ job }: { job: Job }) {
  switch (job.status) {
    case 'queued': return <span className="pill">Waiting</span>;
    case 'torbox': {
      const name = SERVICE_NAMES[job.torbox.service ?? 'torbox'];
      return <span className="pill">{job.torbox.state?.startsWith('Queued on') ? `${name} queue` : `At ${name}`}</span>;
    }
    case 'downloading': return <span className="pill transfer">Downloading</span>;
    case 'paused': return <span className="pill warning">Paused</span>;
    case 'completed': return <span className="pill positive">In library</span>;
    case 'failed': return <span className="pill negative">Failed</span>;
    case 'cancelled': return <span className="pill">Cancelled</span>;
  }
}

function JobRow({ job, onChange }: { job: Job; onChange: () => void }) {
  const toast = useToast();
  const active = useService().name;
  const [open, setOpen] = useState(false);
  const run = async (action: () => Promise<unknown>, done?: string) => {
    try { await action(); onChange(); if (done) toast(done); } catch (error) { toast((error as Error).message, 'error'); }
  };
  const link = `/title/${job.type}/${job.imdbId}${job.season !== undefined ? `?season=${job.season}` : ''}`;
  const progress = progressOf(job);
  const { total, done, videos, videosDone } = sizes(job);
  const left = job.status === 'downloading' && job.speed > 0 ? (total - done) / job.speed : job.status === 'torbox' ? job.torbox.eta ?? 0 : 0;
  const rate = job.status === 'downloading' ? job.speed : job.status === 'torbox' ? job.torbox.speed ?? 0 : 0;
  const service = SERVICE_NAMES[job.torbox.service ?? 'torbox'];
  const detail = job.status === 'torbox' ? `${service} is fetching the torrent` : job.status === 'downloading' ? `${videosDone} of ${videos} file${videos === 1 ? '' : 's'} · ${bytes(done)} of ${bytes(total)}`
    : job.status === 'completed' ? `Finished ${ago(job.completedAt)} · ${bytes(total)}` : job.status === 'queued' ? job.note ?? `Waiting to send to ${active}` : '';

  const actions: Array<MenuAction | 'separator'> = [];
  if (job.status === 'queued' || job.status === 'torbox' || job.status === 'downloading') actions.push({ label: 'Pause', onSelect: () => run(() => api.jobAction(job.id, 'pause')) });
  if (job.status === 'paused') actions.push({ label: 'Resume', onSelect: () => run(() => api.jobAction(job.id, 'resume')) });
  if (job.status === 'failed' || job.status === 'cancelled') actions.push({ label: 'Try again', onSelect: () => run(() => api.jobAction(job.id, 'retry')) });
  if (job.files.length) actions.push({ label: open ? 'Hide files' : 'Show files', onSelect: () => setOpen((value) => !value) });
  actions.push('separator');
  actions.push(ACTIVE.has(job.status)
    ? { label: 'Cancel download', danger: true, onSelect: () => run(() => api.jobAction(job.id, 'cancel'), 'Download cancelled') }
    : { label: 'Remove from list', onSelect: () => run(() => api.removeJob(job.id)) });

  return (
    <div className={`trow tall ${open ? 'open' : ''}`}>
      <Link to={link} className="ident">
        <div className="poster-thumb">{job.poster && <img src={job.poster} alt="" loading="lazy" />}</div>
        <div style={{ minWidth: 0 }}>
          <div className="t1 truncate">{job.title}</div>
          <div className="t2 truncate">{join([job.label === 'Movie' ? 'Movie' : job.label, RES[job.release.info.resolution], job.release.kind === 'season' || job.release.kind === 'multi-season' ? 'season pack' : ''])}</div>
          <div className="mobile-line"><StatusPill job={job} />{rate > 0 && <span>{speed(rate)}</span>}{duration(left) && <span>{duration(left)} left</span>}</div>
        </div>
      </Link>
      <div className="hide-sm" style={{ minWidth: 0 }}>
        <div className={`bar ${job.status === 'completed' ? 'done' : progress.remote ? 'remote' : ''}`}><i style={{ width: `${Math.round(progress.value * 100)}%` }} /></div>
        <div className="t2 truncate" style={{ marginTop: 6 }}><span className="num" style={{ color: 'var(--text)' }}><Figure value={Math.round(progress.value * 100)} suffix="%" /></span>{detail ? ` · ${detail}` : ''}</div>
      </div>
      <span className="r num hide-sm" style={{ color: job.status === 'downloading' ? 'var(--accent)' : 'var(--muted)' }}>{rate > 0 ? speed(rate) : '–'}</span>
      <span className="r num muted hide-sm">{duration(left) || '–'}</span>
      <span className="hide-sm"><StatusPill job={job} /></span>
      <Menu label={`Actions for ${job.title}`} actions={actions} trigger={<button className="btn ghost sm icon" style={{ justifySelf: 'end' }}><MoreHorizontal size={17} /></button>} />
      {(job.note && job.status !== 'queued') || job.error ? (
        <div style={{ gridColumn: '1 / -1' }}>
          {job.note && job.status !== 'queued' && <div className="notice warning">{job.note}</div>}
          {job.error && <div className="notice negative">{job.error}</div>}
        </div>
      ) : null}
      {open && (
        <div className="expand">
          {job.files.map((file) => {
            const finished = file.status === 'done' || file.status === 'skipped';
            const pct = finished ? 100 : file.size ? Math.round((file.downloaded / file.size) * 100) : 0;
            return (
              <div key={file.key} className="row" style={{ padding: '8px 0', gap: 16 }}>
                <div className="grow">
                  <div className="truncate">{file.target.split(/[\\/]/).pop()}</div>
                  <div className="t2 truncate" title={file.target}>{file.target}</div>
                  {file.error && !finished && <div style={{ color: 'var(--negative)', fontSize: 12 }}>{file.error}</div>}
                </div>
                <div className={`bar hide-sm ${finished ? 'done' : ''}`} style={{ width: 120 }}><i style={{ width: `${pct}%` }} /></div>
                <span className="num faint" style={{ width: 52, textAlign: 'right' }}>{file.status === 'skipped' ? 'Had it' : file.status === 'failed' ? 'Failed' : `${pct}%`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** In progress, with nothing running: what happened lately and where to go next. */
function Idle({ jobs, onShowFinished }: { jobs: Job[]; onShowFinished: () => void }) {
  const service = useService().name;
  const openSearch = useOpenSearch();
  const week = Date.now() - 7 * 86_400_000;
  const recent = jobs.filter((job) => job.status === 'completed' && (job.completedAt ?? 0) > week);
  const size = recent.reduce((sum, job) => sum + job.files.reduce((total, file) => total + (file.status === 'done' ? file.size : 0), 0), 0);
  return (
    <section className="card idle">
      <div>
        <h2>Nothing downloading right now</h2>
        <p className="muted">
          {recent.length
            ? <>{recent.length} download{recent.length === 1 ? '' : 's'} finished this week, {bytes(size)} in all. The latest was {recent[0]!.title}{recent[0]!.label ? `, ${recent[0]!.label}` : ''}.</>
            : `Pick a show or a movie and it lands here while ${service} and Haul fetch it.`}
        </p>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={openSearch}>Find a title</button>
        <Link to="/upcoming" className="btn">See what's coming up</Link>
        {recent.length > 0 && <button className="btn ghost" onClick={onShowFinished}>Show finished</button>}
      </div>
    </section>
  );
}

export function Downloads() {
  const service = useService().name;
  const toast = useToast();
  const { data, error, reload, setData } = useAsync(() => api.downloads(), []);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const [query, setQuery] = useState('');
  usePolling(() => { api.downloads().then(setData, () => undefined); }, 1500);

  const jobs = data?.jobs ?? [];
  const groups: Record<Tab, Job[]> = {
    active: jobs.filter((job) => ACTIVE.has(job.status)),
    done: jobs.filter((job) => job.status === 'completed'),
    stopped: jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled')
  };
  // With nothing running, In progress shows what finished lately; failures still come first.
  const tab: Tab = chosen ?? (groups.active.length ? 'active' : groups.stopped.some((job) => job.status === 'failed') ? 'stopped' : 'active');
  const visible = groups[tab].filter((job) => !query || job.title.toLowerCase().includes(query.toLowerCase()));
  const rate = groups.active.reduce((sum, job) => sum + (job.status === 'downloading' ? job.speed : 0), 0);

  return (
    <div className="canvas">
      <div className="title-row">
        <div>
          <h1>Downloads</h1>
          <div className="sub">{groups.active.length ? <>{groups.active.length} in progress{rate ? <> · <span style={{ color: 'var(--accent)' }}>{speed(rate)}</span></> : null}</> : `${service} fetches each torrent; Haul then downloads the files to this machine.`}</div>
        </div>
        {groups.done.length > 0 && <button className="btn" onClick={async () => { await api.clearFinished(); reload(); toast('Finished downloads cleared from the list'); }}>Clear finished</button>}
      </div>
      <TabBar value={tab} onChange={setChosen} tabs={[
        { value: 'active', label: 'In progress', count: groups.active.length },
        { value: 'done', label: 'Finished', count: groups.done.length },
        { value: 'stopped', label: 'Failed or cancelled', count: groups.stopped.length }
      ]} />
      <div className="toolbar">
        <input className="input filter" placeholder="Filter by title" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter downloads" />
        <span className="count">{visible.length} download{visible.length === 1 ? '' : 's'}</span>
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && !visible.length && tab === 'active' && !query && <Idle jobs={data.jobs} onShowFinished={() => setChosen('done')} />}
      {data && !visible.length && (tab !== 'active' || query) && (
        <Empty title={query ? 'No downloads match' : tab === 'done' ? 'Nothing finished yet' : 'No problems'} />
      )}
      {visible.length > 0 && (
        <div className="table job-table">
          <div className="thead"><span>Title</span><span>Progress</span><span className="r">Speed</span><span className="r">Time left</span><span>Status</span><span /></div>
          {visible.map((job) => <JobRow key={job.id} job={job} onChange={reload} />)}
        </div>
      )}
    </div>
  );
}
