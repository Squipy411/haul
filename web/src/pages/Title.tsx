import { Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Episode, MediaType, Meta, Release, SeasonPlan } from '../../../shared/types';
import { api } from '../api';
import { Quality, ReleaseList, Specs } from '../components/Releases';
import { Empty, ErrorNote, Loading, MetaLine, Modal, Poster, Toggle } from '../components/ui';
import { airDate, bytes, episodeRange, pad, useAsync, useRouter, useToast } from '../lib';

const aired = (episode: Episode) => !episode.released || Date.parse(episode.released) <= Date.now() + 12 * 3600_000;

function useDownloader(meta: Meta | undefined) {
  const toast = useToast();
  const { navigate } = useRouter();
  return async (items: Array<{ release: Release; season?: number; episodes?: number[] }>, label: string): Promise<boolean> => {
    if (!meta) return false;
    try {
      if (items.length === 1) {
        await api.download({ type: meta.type, imdbId: meta.id, release: items[0]!.release, season: items[0]!.season, episodes: items[0]!.episodes });
      } else {
        await api.download({ type: meta.type, imdbId: meta.id, items: items.map((item) => ({ release: item.release, season: item.season!, episodes: item.episodes ?? [] })) });
      }
      window.dispatchEvent(new Event('haul:refresh-status'));
      toast(<span>Queued {label}. <a href="/downloads" onClick={(event) => { event.preventDefault(); navigate('/downloads'); }}>Downloads →</a></span>);
      return true;
    } catch (error) {
      toast((error as Error).message, 'error');
      return false;
    }
  };
}

function PlanModal({ meta, season, episodes, onClose }: { meta: Meta; season: number; episodes?: number[]; onClose: () => void }) {
  const download = useDownloader(meta);
  const [skipOwned, setSkipOwned] = useState(true);
  const { data: plan, error, loading, reload } = useAsync<SeasonPlan>(() => api.planSeason(meta.id, season, episodes, skipOwned), [meta.id, season, skipOwned]);
  const [busy, setBusy] = useState(false);
  const count = plan ? plan.items.reduce((sum, item) => sum + item.episodes.length, 0) : 0;

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    const ok = await download(plan.items.map((item) => ({ release: item.release, season, episodes: item.episodes })), `${meta.name} season ${season}`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title={`Season ${season}${episodes?.length ? `, ${episodeRange(episodes)}` : ''}`}
      subtitle="One pack where a good one exists, otherwise each episode on its own. Check it before it starts."
      onClose={onClose}
      footer={
        <>
          <label className="row" style={{ cursor: 'pointer', fontSize: 13 }}>
            <Toggle checked={skipOwned} onChange={setSkipOwned} label="Skip owned episodes" />
            Skip episodes I already have
          </label>
          <div className="row">
            <button className="btn quiet" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!plan || !count || busy} onClick={start}>
              {busy && <span className="spinner" />}Download {count} episode{count === 1 ? '' : 's'}
            </button>
          </div>
        </>
      }
    >
      {loading && <Loading text="Comparing season packs and single episodes" />}
      {error && <ErrorNote message={error} onRetry={reload} />}
      {plan && !loading && (
        <>
          <div className="figures">
            <div><b>{count}</b><span className="label">Episodes</span></div>
            <div><b className={plan.cachedCount ? 'ok' : ''}>{plan.cachedCount}</b><span className="label">Cached on TorBox</span></div>
            <div><b>{plan.totalSize ? bytes(plan.totalSize) : '—'}</b><span className="label">Estimated size</span></div>
          </div>
          {!plan.items.length && (
            <Empty title="Nothing to download">{plan.skipped.length ? 'Every episode is already in your library or hasn’t aired.' : 'No releases were found for this season.'}</Empty>
          )}
          {plan.items.map((item) => (
            <div key={item.release.hash} className="plan-row">
              <div className="mono" style={{ fontSize: 12.5 }}>{item.episodes.length > 1 ? episodeRange(item.episodes) : `E${item.episodes[0]}`}</div>
              <div style={{ minWidth: 0 }}>
                <div className="mono ellipsis" style={{ fontSize: 12.5 }} title={item.release.name}>{item.release.name}</div>
                <Specs release={item.release} season={season} />
              </div>
              <div className="row" style={{ gap: 12 }}>
                <Quality resolution={item.release.info.resolution} />
                <span className={`tag ${item.release.cached ? 'ok' : ''}`}>{item.release.cached ? 'Cached' : 'Fetch'}</span>
              </div>
            </div>
          ))}
          <div className="stack" style={{ gap: 8, marginTop: 14 }}>
            {plan.missing.length > 0 && <div className="note warn">Nothing found for {episodeRange(plan.missing)}. Try those episodes one by one later.</div>}
            {plan.skipped.length > 0 && <div className="note">Skipping {episodeRange(plan.skipped)}: already owned or not aired.</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

function EpisodeRow({ meta, episode, selected, onToggle, open, onOpen }: {
  meta: Meta; episode: Episode; selected: boolean; onToggle: () => void; open: boolean; onOpen: () => void;
}) {
  const download = useDownloader(meta);
  const isAired = aired(episode);
  const releases = useAsync(() => (open ? api.episodeReleases(meta.id, episode.season, episode.episode) : Promise.resolve(null)), [open]);
  const code = `S${pad(episode.season)}E${pad(episode.episode)}`;
  return (
    <div className="episode">
      <button className={`check ${selected ? 'on' : ''}`} onClick={onToggle} disabled={!isAired} aria-label={`Select ${code}`}>
        {selected && <Check size={12} strokeWidth={3} />}
      </button>
      <span className="code">E{pad(episode.episode)}</span>
      <div className="thumb">{episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />}</div>
      <div style={{ minWidth: 0 }}>
        <h4 className="ellipsis">{episode.title}</h4>
        <div className="meta-line" style={{ fontSize: 11.5 }}>{airDate(episode.released)}</div>
        {episode.overview && <p>{episode.overview}</p>}
      </div>
      <div className="side">
        {episode.owned && <span className="tag ok">Owned</span>}
        {!isAired && <span className="tag">Not aired</span>}
        {isAired && <button className={`btn sm ${open ? '' : 'quiet'}`} onClick={onOpen}>{open ? 'Close' : 'Releases'}</button>}
      </div>
      {open && (
        <div className="episode-releases">
          {releases.loading && <Loading text={`Searching ${code}`} />}
          {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
          {releases.data && (
            <ReleaseList
              compact
              season={episode.season}
              releases={releases.data.releases}
              emptyText="No torrents for this episode yet."
              onDownload={(release) => download([{ release, season: episode.season, episodes: [episode.episode] }], `${meta.name} ${code}`)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SeriesSection({ meta }: { meta: Meta }) {
  const { search, navigate } = useRouter();
  const seasons = meta.seasons.filter((season) => season > 0).concat(meta.seasons.includes(0) ? [0] : []);
  const latestAired = [...seasons].reverse().find((season) => season > 0 && meta.episodes.some((episode) => episode.season === season && aired(episode)));
  const requested = search.has('season') ? Number(search.get('season')) : Number.NaN;
  const [season, setSeason] = useState<number>(seasons.includes(requested) ? requested : (latestAired ?? seasons[0] ?? 1));
  const [tab, setTab] = useState<'episodes' | 'packs'>(search.get('tab') === 'packs' ? 'packs' : 'episodes');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openEpisode, setOpenEpisode] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ episodes?: number[] } | null>(null);
  const [packSkipOwned, setPackSkipOwned] = useState(true);
  const download = useDownloader(meta);

  const episodes = useMemo(() => meta.episodes.filter((episode) => episode.season === season), [meta, season]);
  const owned = episodes.filter((episode) => episode.owned);
  const unaired = episodes.filter((episode) => !aired(episode));
  const missing = episodes.filter((episode) => !episode.owned && aired(episode));
  const packs = useAsync(() => (tab === 'packs' ? api.seasonPacks(meta.id, season) : Promise.resolve(null)), [tab, season, meta.id]);

  useEffect(() => { setSelected(new Set()); setOpenEpisode(null); }, [season]);
  const chooseSeason = (value: number) => {
    setSeason(value);
    navigate(`/title/series/${meta.id}?season=${value}`, { replace: true });
  };
  const toggle = (episode: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(episode)) next.delete(episode); else next.add(episode);
    return next;
  });

  const downloadPack = (release: Release) => {
    // With nothing missing, a pack download is an upgrade: take every episode.
    const wanted = packSkipOwned && owned.length > 0 && missing.length > 0 ? missing.map((episode) => episode.episode) : undefined;
    return download([{ release, season, episodes: wanted }], `${meta.name} season ${season}`);
  };

  if (!seasons.length) return <Empty title="No episodes listed">The catalog has no episode list for this series yet.</Empty>;

  return (
    <section>
      <div className="tabs mono" style={{ marginBottom: 0 }}>
        {seasons.map((value) => (
          <button key={value} className={value === season ? 'on' : ''} onClick={() => chooseSeason(value)}>{value === 0 ? 'SPECIALS' : `S${pad(value)}`}</button>
        ))}
      </div>

      <div className="season-actions">
        <button className="btn primary" onClick={() => setPlan({})} disabled={!missing.length && !owned.length}>Download season {season}</button>
        <button className="btn" onClick={() => setTab('packs')}>Compare season packs</button>
        <span className="grow" />
        <MetaLine parts={[`${episodes.length} episodes`, owned.length > 0 && `${owned.length} owned`, unaired.length > 0 && `${unaired.length} not aired`]} />
      </div>

      <div className="season-strip" style={{ marginTop: 6 }}>
        <div className="tabs" style={{ borderBottom: 0 }}>
          <button className={tab === 'episodes' ? 'on' : ''} onClick={() => setTab('episodes')}>Episodes</button>
          <button className={tab === 'packs' ? 'on' : ''} onClick={() => setTab('packs')}>Season packs</button>
        </div>
        {tab === 'episodes' && missing.length > 0 && (
          <button className="btn quiet sm" onClick={() => setSelected(selected.size ? new Set() : new Set(missing.map((episode) => episode.episode)))}>
            {selected.size ? 'Clear selection' : `Select ${missing.length} missing`}
          </button>
        )}
        {tab === 'packs' && owned.length > 0 && (
          <label className="row" style={{ fontSize: 13, cursor: 'pointer' }}>
            <Toggle checked={packSkipOwned} onChange={setPackSkipOwned} label="Skip owned episodes" />
            Skip the {owned.length} episode{owned.length === 1 ? '' : 's'} I have
          </label>
        )}
      </div>

      {tab === 'episodes' && (
        <div className="episodes" style={{ borderTop: '1px solid var(--line)' }}>
          {episodes.map((episode) => (
            <EpisodeRow
              key={episode.id}
              meta={meta}
              episode={episode}
              selected={selected.has(episode.episode)}
              onToggle={() => toggle(episode.episode)}
              open={openEpisode === episode.episode}
              onOpen={() => setOpenEpisode(openEpisode === episode.episode ? null : episode.episode)}
            />
          ))}
        </div>
      )}

      {tab === 'packs' && (
        <div>
          {packs.loading && <Loading text={`Looking for season ${season} packs`} />}
          {packs.error && <ErrorNote message={packs.error} onRetry={packs.reload} />}
          {packs.data && (
            <ReleaseList
              season={season}
              releases={packs.data.releases}
              emptyText={`No packs found for season ${season}. "Download season ${season}" will fetch the episodes one by one instead.`}
              onDownload={downloadPack}
            />
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="selection">
          <span className="mono" style={{ fontSize: 12.5 }}>{selected.size} selected · {episodeRange([...selected])}</span>
          <span className="grow" />
          <button className="btn quiet sm" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn primary sm" onClick={() => setPlan({ episodes: [...selected].sort((a, b) => a - b) })}>Download selected</button>
        </div>
      )}

      {plan && <PlanModal meta={meta} season={season} episodes={plan.episodes} onClose={() => { setPlan(null); setSelected(new Set()); }} />}
    </section>
  );
}

function MovieSection({ meta }: { meta: Meta }) {
  const download = useDownloader(meta);
  const releases = useAsync(() => api.movieReleases(meta.id), [meta.id]);
  return (
    <section>
      <div className="tabs"><button className="on">Releases</button></div>
      {releases.loading && <Loading text="Searching torrents and checking TorBox" />}
      {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
      {releases.data && <ReleaseList releases={releases.data.releases} onDownload={(release) => download([{ release }], meta.name)} />}
    </section>
  );
}

export function TitlePage({ type, id }: { type: MediaType; id: string }) {
  const { back } = useRouter();
  const { data: meta, error, reload } = useAsync(() => api.meta(type, id), [type, id]);
  if (error) return <div className="page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!meta) return <Loading />;
  return (
    <div className="title-wrap">
      {meta.background && <div className="backdrop" style={{ backgroundImage: `url(${meta.background})` }} />}
      <div className="page" style={{ position: 'relative' }}>
        <button className="btn quiet" style={{ marginLeft: -8 }} onClick={() => back('/')}>← Back</button>
        <div className="title-head">
          <div className="poster-slot"><Poster src={meta.poster} title={meta.name} owned={meta.inLibrary} /></div>
          <div className="info">
            <span className="label">{meta.type === 'series' ? `Series · ${meta.seasons.filter((season) => season > 0).length} seasons` : 'Film'}</span>
            <h1>{meta.name}</h1>
            <MetaLine parts={[meta.releaseInfo, meta.runtime, ...(meta.genres ?? []).slice(0, 3), meta.imdbRating && `IMDb ${meta.imdbRating}`, meta.type === 'series' && meta.status]} />
            {meta.description && <p>{meta.description}</p>}
            {meta.cast?.length ? <div className="faint" style={{ fontSize: 13, marginTop: 10 }}>With {meta.cast.slice(0, 4).join(', ')}</div> : null}
            {meta.ownedMovie && <div style={{ marginTop: 14 }}><span className="tag ok">In your library</span></div>}
          </div>
        </div>
        {meta.type === 'series' ? <SeriesSection meta={meta} /> : <MovieSection meta={meta} />}
      </div>
    </div>
  );
}
