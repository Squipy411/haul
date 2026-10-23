import { useState } from 'react';
import type { Job } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, Seg } from '../components/ui';
import { Link, ago, bytes, duration, speed, useAsync, usePolling, useToast } from '../lib';

type Filter = 'active' | 'done' | 'stopped' | 'all';

const ACTIVE = new Set(['queued', 'torbox', 'downloading', 'paused']);

function totals(job: Job) {
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  const done = job.files.reduce((sum, file) => sum + Math.min(file.downloaded, file.size), 0);
  const videos = job.files.filter((file) => file.kind === 'video');
  return {
    total,
    done,
    videos: videos.length,
    videosDone: videos.filter((file) => file.status === 'done' || file.status === 'skipped').length
  };
}

function Stages({ job }: { job: Job }) {
  const { total, done } = totals(job);
  const onServer = job.files.length > 0;
  const torbox = onServer || job.status === 'completed' ? 1 : job.status === 'queued' ? 0 : Math.max(0.03, job.torbox.progress ?? 0);
  const server = job.status === 'completed' ? 1 : total ? done / total : 0;
  const library = job.status === 'completed' ? 1 : 0;
  const steps = [
    { label: 'TorBox', value: torbox, on: job.status === 'torbox' || job.status === 'queued' },
    { label: 'Server', value: server, on: job.status === 'downloading' },
    { label: 'Library', value: library, on: false }
  ];
  return (
    <div className="stages">
      {steps.map((step) => (
        <div key={step.label} className={`stage ${step.value >= 1 ? 'done' : step.on ? 'on' : ''}`}>
          <div className="bar"><i style={{ width: `${Math.round(step.value * 100)}%` }} /></div>
          <span className="label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function statusText(job: Job): string[] {
  const { total, done, videos, videosDone } = totals(job);
  switch (job.status) {
    case 'queued':
      return [job.note ?? 'Waiting to send to TorBox'];
    case 'torbox':
      if (job.torbox.state === 'Queued on TorBox') return ['Queued on TorBox, all slots busy'];
      return [
        `TorBox ${Math.round((job.torbox.progress ?? 0) * 100)}%`,
        job.torbox.state ? job.torbox.state.toLowerCase() : '',
        speed(job.torbox.speed),
        job.torbox.eta ? `${duration(job.torbox.eta)} left` : ''
      ].filter(Boolean);
    case 'downloading': {
      const eta = job.speed > 0 ? (total - done) / job.speed : 0;
      return [`${videosDone}/${videos} files`, `${bytes(done)} of ${bytes(total)}`, speed(job.speed), eta ? `${duration(eta)} left` : ''].filter(Boolean);
    }
    case 'paused': return ['Paused', total ? `${bytes(done)} of ${bytes(total)}` : ''].filter(Boolean);
    case 'completed': return [`Finished ${ago(job.completedAt)}`, `${videos} file${videos === 1 ? '' : 's'}`, bytes(total)];
    case 'failed': return ['Failed'];
    case 'cancelled': return ['Cancelled'];
  }
}

function JobRow({ job, onChange }: { job: Job; onChange: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); onChange(); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); }
  };
  const link = `/title/${job.type}/${job.imdbId}${job.season !== undefined ? `?season=${job.season}` : ''}`;
  const res = job.release.info.resolution;

  return (
    <div className="job">
      <Link to={link} className="thumb">{job.poster && <img src={job.poster} alt="" loading="lazy" />}</Link>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <h3><Link to={link}>{job.title}</Link></h3>
          <span className="tag">{job.label}</span>
          {res !== 'unknown' && <span className="tag">{res}</span>}
        </div>
        <div className="rname ellipsis" title={job.release.name}>{job.release.name}</div>
        <Stages job={job} />
        <div className="job-status">
          {statusText(job).map((part, index) => <span key={index}>{part}</span>)}
          {job.files.length > 0 && (
            <button className="btn quiet sm" style={{ height: 18, padding: 0 }} onClick={() => setOpen((value) => !value)}>{open ? 'Hide files' : 'Files'}</button>
          )}
        </div>
        {job.note && job.status !== 'queued' && <div className="note warn">{job.note}</div>}
        {job.error && <div className="note bad">{job.error}</div>}
        {open && (
          <div className="job-files">
            {job.files.map((file) => {
              const pct = file.size ? Math.round((file.downloaded / file.size) * 100) : 0;
              const finished = file.status === 'done' || file.status === 'skipped';
              return (
                <div key={file.key} className="job-file">
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis">{file.target.split(/[\\/]/).pop()}</div>
                    <div className="path ellipsis" title={file.target}>{file.target}</div>
                    {file.error && !finished && <div className="bad" style={{ fontSize: 11 }}>{file.error}</div>}
                  </div>
                  <div className={`thin ${finished ? 'done' : ''}`}><i style={{ width: `${finished ? 100 : pct}%` }} /></div>
                  <span className="faint" style={{ textAlign: 'right' }}>{file.status === 'skipped' ? 'had it' : file.status === 'done' ? 'done' : file.status === 'failed' ? 'failed' : `${pct}%`}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="actions">
        {(job.status === 'queued' || job.status === 'torbox' || job.status === 'downloading') && <button className="btn sm" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'pause'))}>Pause</button>}
        {job.status === 'paused' && <button className="btn sm" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'resume'))}>Resume</button>}
        {(job.status === 'failed' || job.status === 'cancelled') && <button className="btn sm" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'retry'))}>Retry</button>}
        {ACTIVE.has(job.status)
          ? <button className="btn sm danger" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'cancel'))}>Cancel</button>
          : <button className="btn sm quiet" disabled={busy} onClick={() => run(() => api.removeJob(job.id))}>Remove</button>}
      </div>
    </div>
  );
}

export function Downloads() {
  const toast = useToast();
  const { data, error, reload, setData } = useAsync(() => api.downloads(), []);
  const [chosen, setChosen] = useState<Filter | null>(null);
  usePolling(() => { api.downloads().then(setData, () => undefined); }, 1500);

  const jobs = data?.jobs ?? [];
  const counts = {
    active: jobs.filter((job) => ACTIVE.has(job.status)).length,
    done: jobs.filter((job) => job.status === 'completed').length,
    stopped: jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled').length
  };
  // Until a tab is picked, show what's running, or everything when nothing is.
  const filter: Filter = chosen ?? (counts.active ? 'active' : 'all');
  const visible = jobs.filter((job) => filter === 'all' ? true
    : filter === 'active' ? ACTIVE.has(job.status)
      : filter === 'done' ? job.status === 'completed'
        : job.status === 'failed' || job.status === 'cancelled');
  const rate = jobs.reduce((sum, job) => sum + (job.status === 'downloading' ? job.speed : 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Downloads</h1>
          <div className="sub mono" style={{ fontSize: 12.5 }}>
            {counts.active ? `${counts.active} active${rate ? ` · ${speed(rate)}` : ''}` : 'Torrents run on TorBox. This server only pulls finished files.'}
          </div>
        </div>
        <div className="row">
          <Seg<Filter>
            value={filter}
            onChange={setChosen}
            options={[
              { value: 'active', label: `ACTIVE ${counts.active}` },
              { value: 'done', label: `DONE ${counts.done}` },
              { value: 'stopped', label: `STOPPED ${counts.stopped}` },
              { value: 'all', label: 'ALL' }
            ]}
          />
          {counts.done > 0 && <button className="btn sm quiet" onClick={async () => { await api.clearFinished(); reload(); toast('Cleared finished downloads'); }}>Clear finished</button>}
        </div>
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && !visible.length && (
        <Empty title={filter === 'active' ? 'Nothing downloading' : 'Nothing here'}>
          {filter === 'active' ? <>Pick something on <Link to="/" className="accent">Discover</Link>.</> : null}
        </Empty>
      )}
      {visible.length > 0 && <div className="jobs">{visible.map((job) => <JobRow key={job.id} job={job} onChange={reload} />)}</div>}
    </div>
  );
}
