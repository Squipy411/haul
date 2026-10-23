import { AlertTriangle, Check, ChevronDown, ChevronUp, Cloud, Download, HardDriveDownload, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { Job } from '../../../shared/types';
import { api } from '../api';
import { ResolutionBadge } from '../components/Releases';
import { Empty, ErrorNote, Loading, Segmented } from '../components/ui';
import { Link, ago, bytes, duration, speed, useAsync, usePolling, useToast } from '../lib';

type Filter = 'active' | 'done' | 'failed' | 'all';

const ACTIVE = new Set(['queued', 'torbox', 'downloading', 'paused']);

function jobProgress(job: Job): { torbox: number; local: number; done: number; total: number; files: number; filesDone: number } {
  const videos = job.files;
  const total = videos.reduce((sum, file) => sum + file.size, 0);
  const done = videos.reduce((sum, file) => sum + Math.min(file.downloaded, file.size), 0);
  return {
    torbox: job.status === 'queued' ? 0 : job.files.length ? 1 : job.torbox.progress ?? 0,
    local: total ? done / total : 0,
    done,
    total,
    files: videos.filter((file) => file.kind === 'video').length,
    filesDone: videos.filter((file) => file.kind === 'video' && (file.status === 'done' || file.status === 'skipped')).length
  };
}

function Stages({ job }: { job: Job }) {
  const stage = job.status === 'queued' ? 0 : job.status === 'torbox' ? 1 : job.status === 'downloading' ? 2 : job.status === 'completed' ? 3 : job.files.length ? 2 : 1;
  const steps = [
    { label: 'Queued', icon: Download },
    { label: 'TorBox', icon: Cloud },
    { label: 'To server', icon: HardDriveDownload },
    { label: 'In library', icon: Check }
  ];
  return (
    <div className="stages">
      {steps.map((step, index) => {
        const Icon = step.icon;
        const state = index < stage || job.status === 'completed' ? 'done' : index === stage ? 'on' : '';
        return (
          <span key={step.label} className="row" style={{ gap: 8 }}>
            {index > 0 && <span className="stage-line" />}
            <span className={`stage ${state}`}><Icon size={13} />{step.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function statusLine(job: Job): string {
  const progress = jobProgress(job);
  switch (job.status) {
    case 'queued': return job.note ?? 'Waiting to send to TorBox…';
    case 'torbox': {
      const pct = Math.round((job.torbox.progress ?? 0) * 100);
      const parts = [`TorBox is fetching the torrent · ${pct}%`];
      if (job.torbox.speed) parts.push(speed(job.torbox.speed));
      if (job.torbox.eta) parts.push(`${duration(job.torbox.eta)} left`);
      return job.torbox.state === 'Queued on TorBox' ? 'Queued on TorBox (all download slots busy)' : parts.join(' · ');
    }
    case 'downloading': {
      const remaining = progress.total - progress.done;
      const eta = job.speed > 0 ? remaining / job.speed : 0;
      return [`Downloading to your server · ${progress.filesDone}/${progress.files} files`, speed(job.speed), eta ? `${duration(eta)} left` : ''].filter(Boolean).join(' · ');
    }
    case 'paused': return 'Paused';
    case 'completed': return `Done ${ago(job.completedAt)} · ${progress.files} file${progress.files === 1 ? '' : 's'} · ${bytes(progress.total)}`;
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}

function JobCard({ job, onChange }: { job: Job; onChange: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const progress = jobProgress(job);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); onChange(); } catch (error) { toast((error as Error).message, 'error'); } finally { setBusy(false); }
  };
  const showLocal = job.status === 'downloading' || (job.status === 'paused' && job.files.length) || job.status === 'completed';
  const percent = showLocal ? progress.local : progress.torbox;
  const link = `/title/${job.type}/${job.imdbId}${job.season !== undefined ? `?season=${job.season}` : ''}`;

  return (
    <div className="job">
      <Link to={link} className="thumb">{job.poster && <img src={job.poster} alt="" loading="lazy" />}</Link>
      <div style={{ minWidth: 0 }}>
        <div className="job-top">
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <h3 className="ellipsis"><Link to={link}>{job.title}</Link></h3>
              <span className="badge outline">{job.label}</span>
              <ResolutionBadge resolution={job.release.info.resolution} />
            </div>
            <div className="release-name ellipsis mono" title={job.release.name}>{job.release.name}</div>
          </div>
          <div className="actions">
            {(job.status === 'queued' || job.status === 'torbox' || job.status === 'downloading') && (
              <button className="btn sm icon" title="Pause" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'pause'))}><Pause size={15} /></button>
            )}
            {job.status === 'paused' && <button className="btn sm" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'resume'))}><Play size={14} />Resume</button>}
            {(job.status === 'failed' || job.status === 'cancelled') && <button className="btn sm" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'retry'))}><RotateCcw size={14} />Retry</button>}
            {ACTIVE.has(job.status)
              ? <button className="btn sm icon danger" title="Cancel" disabled={busy} onClick={() => run(() => api.jobAction(job.id, 'cancel'))}><X size={15} /></button>
              : <button className="btn sm icon ghost" title="Remove from list" disabled={busy} onClick={() => run(() => api.removeJob(job.id))}><Trash2 size={15} /></button>}
          </div>
        </div>
        <Stages job={job} />
        <div className={`progress ${job.status === 'completed' ? 'good' : !showLocal ? 'torbox' : ''}`}>
          <div style={{ width: `${Math.max(job.status === 'queued' ? 0 : 2, Math.round(percent * 100))}%` }} />
        </div>
        <div className="job-meta">
          <span>{statusLine(job)}</span>
          <span className="row" style={{ gap: 12 }}>
            {showLocal && progress.total > 0 && <span>{bytes(progress.done)} of {bytes(progress.total)}</span>}
            {job.files.length > 0 && (
              <button className="btn ghost sm" style={{ height: 24 }} onClick={() => setOpen((value) => !value)}>
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}Files
              </button>
            )}
          </span>
        </div>
        {job.note && job.status !== 'queued' && <div className="notice warn"><AlertTriangle size={16} />{job.note}</div>}
        {job.error && <div className="notice bad"><AlertTriangle size={16} />{job.error}</div>}
        {open && (
          <div className="job-files">
            {job.files.map((file) => (
              <div key={file.key} className="job-file">
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis">{file.episode !== undefined ? `E${file.episode}${file.episodeEnd ? `–E${file.episodeEnd}` : ''} · ` : ''}{file.kind === 'subtitle' ? 'Subtitles · ' : ''}{file.target.split(/[\\/]/).pop()}</div>
                  <div className="path ellipsis mono" title={file.target}>{file.target}</div>
                  {file.error && file.status !== 'done' && <div style={{ color: 'var(--bad)', fontSize: 11.5 }}>{file.error}</div>}
                </div>
                <div className={`progress thin ${file.status === 'done' || file.status === 'skipped' ? 'good' : ''}`}><div style={{ width: `${file.size ? Math.round((file.downloaded / file.size) * 100) : 0}%` }} /></div>
                <div className="pct faint" style={{ textAlign: 'right' }}>
                  {file.status === 'skipped' ? 'Had it' : file.status === 'done' ? 'Done' : file.status === 'failed' ? 'Failed' : `${file.size ? Math.round((file.downloaded / file.size) * 100) : 0}%`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Downloads() {
  const toast = useToast();
  const { data, error, reload, setData } = useAsync(() => api.downloads(), []);
  const [filter, setFilter] = useState<Filter>('active');
  usePolling(() => { api.downloads().then(setData, () => undefined); }, 1500);

  const jobs = data?.jobs ?? [];
  const counts = {
    active: jobs.filter((job) => ACTIVE.has(job.status)).length,
    done: jobs.filter((job) => job.status === 'completed').length,
    failed: jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled').length
  };
  const visible = jobs.filter((job) =>
    filter === 'all' ? true
      : filter === 'active' ? ACTIVE.has(job.status)
        : filter === 'done' ? job.status === 'completed'
          : job.status === 'failed' || job.status === 'cancelled');
  const totalSpeed = jobs.reduce((sum, job) => sum + (job.status === 'downloading' ? job.speed : 0), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Downloads</h1>
          <div className="page-sub">{counts.active ? `${counts.active} in progress${totalSpeed ? ` · ${speed(totalSpeed)}` : ''}` : 'Everything goes through TorBox. Nothing is torrented on your server.'}</div>
        </div>
        <div className="row">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'active', label: `Active${counts.active ? ` ${counts.active}` : ''}` },
              { value: 'done', label: `Done${counts.done ? ` ${counts.done}` : ''}` },
              { value: 'failed', label: `Failed${counts.failed ? ` ${counts.failed}` : ''}` },
              { value: 'all', label: 'All' }
            ]}
          />
          {(counts.done > 0) && (
            <button className="btn sm ghost" onClick={async () => { await api.clearFinished(); reload(); toast('Cleared finished downloads'); }}>Clear finished</button>
          )}
        </div>
      </div>
      {error && <ErrorNote message={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && !visible.length && (
        <Empty icon={<Download size={34} />} title={filter === 'active' ? 'Nothing downloading' : 'Nothing here yet'}>
          {filter === 'active' ? <>Find something on <Link to="/" style={{ color: 'var(--accent)' }}>Discover</Link> and pick a season or a release.</> : null}
        </Empty>
      )}
      <div className="jobs">
        {visible.map((job) => <JobCard key={job.id} job={job} onChange={reload} />)}
      </div>
    </div>
  );
}
