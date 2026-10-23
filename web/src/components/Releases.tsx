import { useMemo, useState } from 'react';
import type { Release } from '../../../shared/types';
import { bytes, episodeRange } from '../lib';

const RES: Record<string, string> = { '2160p': '2160p', '1080p': '1080p', '720p': '720p', '480p': 'SD', unknown: '—' };

export function Quality({ resolution }: { resolution: string }) {
  return <span className={`q ${resolution === '2160p' ? 'k4' : ''}`}>{RES[resolution] ?? resolution}</span>;
}

/** Pack coverage and technical specs as one quiet line: "S01 PACK E1–7 · BLURAY · HEVC 10-BIT · DTS-HD". */
export function Specs({ release, season }: { release: Release; season?: number }) {
  const { info } = release;
  const pack = release.kind === 'season'
    ? `S${String(season ?? info.seasons[0] ?? '').padStart(2, '0')} pack${release.packEpisodes?.length ? ` ${episodeRange(release.packEpisodes)}` : ''}`
    : release.kind === 'multi-season'
      ? `${release.packSeasons?.length ? `S${release.packSeasons[0]}–S${release.packSeasons[release.packSeasons.length - 1]}` : 'Complete'} pack${season !== undefined ? `, takes S${season}` : ''}`
      : null;
  const parts = [
    info.source,
    ...info.hdr,
    info.codec && `${info.codec}${info.bitDepth ? ` ${info.bitDepth}-bit` : ''}`,
    ...info.audio.slice(0, 2),
    info.channels,
    ...info.languages,
    info.upscaled && 'upscaled',
    info.lowQuality && 'cam'
  ].filter(Boolean);
  return (
    <div className="specs">
      {pack && <span className="pk">{pack}</span>}
      {pack && parts.length > 0 && ' · '}
      {parts.join(' · ')}
    </div>
  );
}

function sizeOf(release: Release): string {
  const isPack = release.kind === 'season' || release.kind === 'multi-season';
  if (isPack && !release.totalSize && release.fileSize) return `${bytes(release.fileSize)}/ep`;
  return bytes(isPack ? release.totalSize ?? release.fileSize : release.fileSize ?? release.totalSize);
}

type Filter = 'all' | '2160p' | '1080p' | '720p';

export function ReleaseList({ releases, onDownload, season, emptyText, compact }: {
  releases: Release[];
  onDownload: (release: Release) => Promise<boolean>;
  season?: number;
  emptyText?: string;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [cachedOnly, setCachedOnly] = useState(false);
  const [limit, setLimit] = useState(compact ? 6 : 20);
  const [busy, setBusy] = useState<string | null>(null);
  const [queued, setQueued] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const release of releases) result[release.info.resolution] = (result[release.info.resolution] ?? 0) + 1;
    return result;
  }, [releases]);
  const cachedCount = releases.filter((release) => release.cached).length;
  const visible = releases.filter((release) => (filter === 'all' || release.info.resolution === filter) && (!cachedOnly || release.cached));
  const unfiltered = filter === 'all' && !cachedOnly;

  const start = async (release: Release) => {
    setBusy(release.hash);
    const ok = await onDownload(release);
    setBusy(null);
    if (ok) setQueued((current) => new Set(current).add(release.hash));
  };

  if (!releases.length) return <div className="note">{emptyText ?? 'No torrents found. Add more sources in Settings.'}</div>;

  return (
    <div>
      <div className="rel-toolbar">
        <div className="filters">
          {(['all', '2160p', '1080p', '720p'] as Filter[]).map((value) => (value === 'all' || counts[value]) ? (
            <button key={value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : RES[value]}<b>{value === 'all' ? releases.length : counts[value]}</b>
            </button>
          ) : null)}
          {cachedCount > 0 && (
            <button className={cachedOnly ? 'on' : ''} onClick={() => setCachedOnly((value) => !value)}>Cached only<b>{cachedCount}</b></button>
          )}
        </div>
        <span className="faint mono" style={{ fontSize: 11.5 }}>Cached = already on TorBox, starts immediately</span>
      </div>
      <div className="rel-table">
        <div className="rel-head"><span>Quality</span><span>Release</span><span style={{ textAlign: 'right' }}>Size</span><span style={{ textAlign: 'right' }}>Seeds</span><span>TorBox</span><span /></div>
        {visible.slice(0, limit).map((release, index) => {
          const pick = index === 0 && unfiltered;
          const isQueued = queued.has(release.hash);
          return (
            <div key={release.hash} className={`rel ${pick ? 'pick' : ''}`}>
              <Quality resolution={release.info.resolution} />
              <div style={{ minWidth: 0 }}>
                <div className="name">{release.name}</div>
                <Specs release={release} season={season} />
              </div>
              <div className="mobile-row">
                <span className="num">{sizeOf(release)}</span>
                <span className="num">{release.seeders ?? '—'}</span>
                <span className={`state ${release.cached ? 'ok' : 'faint'}`}>
                  <span className={`sq ${release.cached ? 'ok' : ''}`} />{release.cached ? 'Cached' : 'Fetch'}
                </span>
              </div>
              <div className="act">
                <button className={`btn sm ${isQueued ? 'done' : pick ? 'primary' : ''}`} disabled={busy === release.hash || isQueued} onClick={() => start(release)}>
                  {busy === release.hash ? <span className="spinner" /> : null}
                  {isQueued ? 'Queued' : 'Download'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {!visible.length && <div className="note" style={{ marginTop: 10 }}>Nothing matches this filter.</div>}
      {visible.length > limit && (
        <button className="btn quiet" style={{ marginTop: 10 }} onClick={() => setLimit((value) => value + 25)}>Show {Math.min(25, visible.length - limit)} more of {visible.length - limit}</button>
      )}
    </div>
  );
}
