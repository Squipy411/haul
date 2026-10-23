import { Check, CloudDownload, Download, HardDrive, Layers, Users, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Release } from '../../../shared/types';
import { bytes, episodeRange } from '../lib';

const RES_LABEL: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD', unknown: '?' };

export function ResolutionBadge({ resolution }: { resolution: string }) {
  const tone = resolution === '2160p' ? 'k4' : resolution === '1080p' ? 'p1080' : resolution === '720p' ? 'p720' : resolution === '480p' ? 'p480' : 'unknown';
  return <span className={`badge res ${tone}`}>{RES_LABEL[resolution] ?? resolution}</span>;
}

export function ReleaseTags({ release, season }: { release: Release; season?: number }) {
  const { info } = release;
  return (
    <>
      {release.kind === 'season' && (
        <span className="badge pack"><Layers size={12} />Season pack{release.packEpisodes?.length ? ` · ${episodeRange(release.packEpisodes)}` : ''}</span>
      )}
      {release.kind === 'multi-season' && (
        <span className="badge pack"><Layers size={12} />{release.packSeasons?.length ? `S${release.packSeasons[0]}–S${release.packSeasons[release.packSeasons.length - 1]}` : 'Complete'} pack{season !== undefined ? ` · takes S${season} only` : ''}</span>
      )}
      {info.source && <span className="badge">{info.source}</span>}
      {info.hdr.map((tag) => <span key={tag} className="badge hdr">{tag}</span>)}
      {info.codec && <span className="badge">{info.codec}{info.bitDepth ? ` ${info.bitDepth}-bit` : ''}</span>}
      {info.audio.slice(0, 2).map((tag) => <span key={tag} className="badge">{tag}</span>)}
      {info.channels && <span className="badge">{info.channels}</span>}
      {info.languages.map((tag) => <span key={tag} className="badge outline">{tag}</span>)}
      {info.upscaled && <span className="badge warn">Upscaled</span>}
      {info.lowQuality && <span className="badge bad">CAM</span>}
    </>
  );
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
  const [limit, setLimit] = useState(compact ? 6 : 15);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const release of releases) result[release.info.resolution] = (result[release.info.resolution] ?? 0) + 1;
    return result;
  }, [releases]);
  const visible = releases.filter((release) => (filter === 'all' || release.info.resolution === filter) && (!cachedOnly || release.cached));
  const cachedCount = releases.filter((release) => release.cached).length;

  const start = async (release: Release) => {
    setBusy(release.hash);
    const ok = await onDownload(release);
    setBusy(null);
    if (ok) setDone((current) => new Set(current).add(release.hash));
  };

  if (!releases.length) {
    return <div className="notice info">{emptyText ?? 'No torrents found. Try another source in Settings → Sources.'}</div>;
  }

  return (
    <div>
      <div className="release-toolbar">
        <div className="chips">
          {(['all', '2160p', '1080p', '720p'] as Filter[]).map((value) => (
            (value === 'all' || counts[value]) ? (
              <button key={value} className={`chip ${filter === value ? 'on' : ''}`} onClick={() => setFilter(value)}>
                {value === 'all' ? `All ${releases.length}` : `${RES_LABEL[value]} ${counts[value]}`}
              </button>
            ) : null
          ))}
          {cachedCount > 0 && (
            <button className={`chip ${cachedOnly ? 'on' : ''}`} onClick={() => setCachedOnly((value) => !value)}>
              <Zap size={13} />Instant {cachedCount}
            </button>
          )}
        </div>
      </div>
      <div className="releases">
        {visible.slice(0, limit).map((release, index) => {
          const size = release.kind === 'season' || release.kind === 'multi-season' ? release.totalSize ?? release.fileSize : release.fileSize ?? release.totalSize;
          const sizeLabel = (release.kind === 'season' || release.kind === 'multi-season') && !release.totalSize && release.fileSize ? `${bytes(release.fileSize)} / ep` : bytes(size);
          const isDone = done.has(release.hash);
          return (
            <div key={release.hash} className={`release ${index === 0 && filter === 'all' && !cachedOnly ? 'best' : ''}`}>
              <ResolutionBadge resolution={release.info.resolution} />
              <div style={{ minWidth: 0 }}>
                <div className="name">{release.name}</div>
                <div className="tags">
                  {index === 0 && filter === 'all' && !cachedOnly && <span className="badge good">Best match</span>}
                  <ReleaseTags release={release} season={season} />
                  <span className="stats">
                    <span><HardDrive size={12} />{sizeLabel}</span>
                    {release.seeders !== undefined && <span><Users size={12} />{release.seeders}</span>}
                    {release.provider && <span>{release.provider}</span>}
                  </span>
                </div>
              </div>
              <div className="act">
                {release.cached
                  ? <span className="badge cached" title="Already on TorBox: downloads start right away"><Zap size={12} fill="currentColor" />Instant</span>
                  : <span className="badge" title="TorBox will fetch this torrent first, then Haul downloads it"><CloudDownload size={12} />TorBox fetch</span>}
                <button className={`btn sm ${isDone ? 'good' : 'primary'}`} disabled={busy === release.hash || isDone} onClick={() => start(release)}>
                  {busy === release.hash ? <span className="spinner" /> : isDone ? <Check size={15} /> : <Download size={15} />}
                  {isDone ? 'Queued' : 'Download'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {!visible.length && <div className="notice info">Nothing matches this filter.</div>}
      {visible.length > limit && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <button className="btn ghost" onClick={() => setLimit((value) => value + 20)}>Show more ({visible.length - limit} left)</button>
        </div>
      )}
    </div>
  );
}
