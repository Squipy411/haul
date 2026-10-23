import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Release, ReleaseInfo } from '../../../shared/types';
import { bytes, episodeRange } from '../lib';
import { Picker, Tip } from './ui';

const RES: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD', unknown: '' };
const HDR: Record<string, string> = { DV: 'Dolby Vision', 'HDR10+': 'HDR10+', HDR10: 'HDR10', HDR: 'HDR' };
const AUDIO: Record<string, string> = { Atmos: 'Atmos', TrueHD: 'TrueHD', 'DTS-HD': 'DTS-HD MA', 'DTS:X': 'DTS:X', DTS: 'DTS', 'DD+': 'DD+', DD: 'DD', AAC: 'AAC', FLAC: 'FLAC', Opus: 'Opus' };

/** Resolution, HDR and audio, marked the way a disc case prints them. */
export function Formats({ info }: { info: ReleaseInfo }) {
  const res = RES[info.resolution];
  return (
    <div className="fmts">
      {res && <span className="fmt res">{res}</span>}
      {info.hdr.map((tag) => <span key={tag} className="fmt">{HDR[tag] ?? tag}</span>)}
      {info.audio.slice(0, 2).map((tag) => <span key={tag} className="fmt">{AUDIO[tag] ?? tag}</span>)}
      {info.channels && <span className="fmt">{info.channels}</span>}
    </div>
  );
}

export function packLine(release: Release, season?: number): string | null {
  if (release.kind === 'season') {
    const which = season ?? release.info.seasons[0];
    return `Season ${which ?? ''} pack${release.packEpisodes?.length ? `, episodes ${episodeRange(release.packEpisodes).replace(/E/g, '')}` : ''}`;
  }
  if (release.kind === 'multi-season') {
    const seasons = release.packSeasons?.length ? `Seasons ${release.packSeasons[0]}–${release.packSeasons[release.packSeasons.length - 1]}` : 'Complete series';
    return `${seasons} pack${season !== undefined ? `, only season ${season} is taken` : ''}`;
  }
  return null;
}

export function sourceLine(info: ReleaseInfo): string {
  return [
    info.source,
    info.codec && `${info.codec}${info.bitDepth ? ` ${info.bitDepth}-bit` : ''}`,
    info.languages.length ? info.languages.join('/') : '',
    info.upscaled && 'upscaled',
    info.lowQuality && 'camera copy'
  ].filter(Boolean).join(' · ');
}

export function sizeOf(release: Release): string {
  const isPack = release.kind === 'season' || release.kind === 'multi-season';
  if (isPack && !release.totalSize && release.fileSize) return `${bytes(release.fileSize)}/ep`;
  return bytes(isPack ? release.totalSize ?? release.fileSize : release.fileSize ?? release.totalSize);
}

export function Availability({ cached }: { cached: boolean }) {
  return cached
    ? <Tip text="TorBox already has this, so it starts right away"><span className="pill positive">Ready now</span></Tip>
    : <Tip text="TorBox downloads the torrent first, then Haul fetches the files"><span className="pill">Fetch first</span></Tip>;
}

type Filter = 'all' | '2160p' | '1080p' | '720p';
type Sort = 'size' | 'match' | 'seeders';

const SORT_KEY = 'haul.releaseSort';
function savedSort(): Sort {
  try { const value = localStorage.getItem(SORT_KEY); if (value === 'size' || value === 'match' || value === 'seeders') return value; } catch { /* storage blocked */ }
  return 'size';
}

/** Size of what would actually be downloaded: one episode, one film, or the season's part of a pack. */
function bytesOf(release: Release): number {
  const isPack = release.kind === 'season' || release.kind === 'multi-season';
  return (isPack ? release.totalSize ?? (release.fileSize ? release.fileSize * Math.max(1, release.packEpisodes?.length ?? 1) : 0) : release.fileSize ?? release.totalSize) ?? 0;
}

export function ReleaseTable({ releases, onDownload, season, emptyText, compact }: {
  releases: Release[];
  onDownload: (release: Release) => Promise<boolean>;
  season?: number;
  emptyText?: string;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [readyOnly, setReadyOnly] = useState(false);
  const [limit, setLimit] = useState(compact ? 5 : 15);
  const [busy, setBusy] = useState<string | null>(null);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [sort, setSortState] = useState<Sort>(savedSort);
  const setSort = (value: Sort) => { setSortState(value); try { localStorage.setItem(SORT_KEY, value); } catch { /* storage blocked */ } };
  const bestHash = releases[0]?.hash;

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const release of releases) result[release.info.resolution] = (result[release.info.resolution] ?? 0) + 1;
    return result;
  }, [releases]);
  const readyCount = releases.filter((release) => release.cached).length;
  const visible = releases
    .filter((release) => (filter === 'all' || release.info.resolution === filter) && (!readyOnly || release.cached))
    .slice()
    .sort((a, b) => sort === 'size' ? bytesOf(b) - bytesOf(a) || b.score - a.score
      : sort === 'seeders' ? (b.seeders ?? 0) - (a.seeders ?? 0) || b.score - a.score
        : b.score - a.score);

  const start = async (release: Release) => {
    setBusy(release.hash);
    const ok = await onDownload(release);
    setBusy(null);
    if (ok) setQueued((current) => new Set(current).add(release.hash));
  };

  if (!releases.length) return <div className="notice">{emptyText ?? 'No torrents found. You can add sources in Settings.'}</div>;

  const filters = (['all', '2160p', '1080p', '720p'] as Filter[]).filter((value) => value === 'all' || counts[value]);

  return (
    <div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, margin: '4px 0 8px' }}>
        {filters.map((value) => (
          <button key={value} className={`btn sm ${filter === value ? 'primary' : ''}`} onClick={() => setFilter(value)}>
            {value === 'all' ? 'All' : RES[value]} <span className="num" style={{ opacity: 0.6 }}>{value === 'all' ? releases.length : counts[value]}</span>
          </button>
        ))}
        {readyCount > 0 && (
          <button className={`btn sm ${readyOnly ? 'primary' : ''}`} onClick={() => setReadyOnly((value) => !value)}>
            {readyOnly && <Check size={14} />}Ready now <span className="num" style={{ opacity: 0.6 }}>{readyCount}</span>
          </button>
        )}
        <span className="grow" />
        <Picker label="Sort versions" value={sort} onChange={setSort} options={[{ value: 'size', label: 'Largest first' }, { value: 'match', label: 'Best match first' }, { value: 'seeders', label: 'Most seeders first' }]} />
      </div>
      <div className="table rel-table">
        <div className="thead"><span>Version</span><span className="r hide-sm">Size</span><span className="r hide-sm">Seeders</span><span className="hide-sm">TorBox</span><span /></div>
        {visible.slice(0, limit).map((release, index) => {
          const best = release.hash === bestHash;
          const isQueued = queued.has(release.hash);
          const pack = packLine(release, season);
          const source = sourceLine(release.info);
          return (
            <div key={release.hash} className="trow">
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <Formats info={release.info} />
                  {pack && <span className="t3" style={{ margin: 0 }}>{pack}</span>}
                  {best && <span className="faint" style={{ fontSize: 12 }}>Best match for your settings</span>}
                </div>
                <div className="release-name">{release.name}{source ? ` · ${source}` : ''}</div>
                <div className="mobile-line">
                  <span>{sizeOf(release)}</span>
                  {release.seeders !== undefined && <span>{release.seeders} seeders</span>}
                  <span style={{ color: release.cached ? 'var(--positive)' : undefined }}>{release.cached ? 'Ready now' : 'Fetch first'}</span>
                </div>
              </div>
              <span className="r num hide-sm">{sizeOf(release)}</span>
              <span className="r num muted hide-sm">{release.seeders ?? '–'}</span>
              <span className="hide-sm"><Availability cached={release.cached} /></span>
              <button className={`btn sm ${best && !isQueued ? 'primary' : ''}`} style={{ justifySelf: 'end' }} disabled={busy === release.hash || isQueued} onClick={() => start(release)}>
                {busy === release.hash ? <span className="spinner" /> : isQueued ? <Check size={14} /> : null}
                {isQueued ? 'Added' : 'Download'}
              </button>
            </div>
          );
        })}
      </div>
      {!visible.length && <div className="notice" style={{ marginTop: 8 }}>Nothing matches. Try another quality.</div>}
      {visible.length > limit && (
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setLimit((value) => value + 25)}>Show {Math.min(25, visible.length - limit)} more</button>
      )}
    </div>
  );
}
