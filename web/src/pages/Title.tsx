import { ArrowLeft, Check, CheckCircle2, Clock, Layers, ListChecks, Play, Sparkles, Star, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Episode, MediaType, Meta, Release, SeasonPlan } from '../../../shared/types';
import { api } from '../api';
import { ReleaseList, ReleaseTags, ResolutionBadge } from '../components/Releases';
import { Empty, ErrorNote, Loading, Modal, Poster } from '../components/ui';
import { Link, airDate, bytes, episodeRange, pad, useAsync, useRouter, useToast } from '../lib';

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
      toast(<span>{label} added. <a href="/downloads" onClick={(event) => { event.preventDefault(); navigate('/downloads'); }}>View downloads</a></span>);
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
  const wantedCount = plan ? plan.items.reduce((sum, item) => sum + item.episodes.length, 0) : 0;

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    const ok = await download(plan.items.map((item) => ({ release: item.release, season, episodes: item.episodes })), `${meta.name} · Season ${season}`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      wide
      title={<>Download Season {season}{episodes?.length ? ` · ${episodeRange(episodes)}` : ''}</>}
      subtitle="Haul picked the best release for every episode: one season pack when a good one exists, otherwise each episode on its own."
      onClose={onClose}
      footer={
        <>
          <label className="row" style={{ cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={skipOwned} onChange={(event) => setSkipOwned(event.target.checked)} />
            Skip episodes already in my library
          </label>
          <div className="row">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!plan || !plan.items.length || busy} onClick={start}>
              {busy ? <span className="spinner" /> : <Check size={16} />}Download {wantedCount} episode{wantedCount === 1 ? '' : 's'}
            </button>
          </div>
        </>
      }
    >
      {loading && (
        <div className="center-load" style={{ padding: '50px 0', gap: 12 }}>
          <div className="spinner lg" />
          <div className="muted">Comparing season packs and single episodes…</div>
        </div>
      )}
      {error && <ErrorNote message={error} onRetry={reload} />}
      {plan && !loading && (
        <>
          <div className="plan-summary">
            <div className="stat"><b>{wantedCount}</b><span>episodes to download</span></div>
            <div className="stat"><b style={{ color: 'var(--good)' }}>{plan.cachedCount}</b><span>instant on TorBox</span></div>
            <div className="stat"><b>{plan.totalSize ? bytes(plan.totalSize) : '—'}</b><span>estimated size</span></div>
          </div>
          {!plan.items.length && <Empty icon={<ListChecks size={30} />} title="Nothing to download">{plan.skipped.length ? 'Every episode is either in your library already or hasn\'t aired yet.' : 'No releases were found for this season.'}</Empty>}
          <div className="stack" style={{ gap: 10 }}>
            {plan.items.map((item) => (
              <div key={item.release.hash} className="plan-item">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{item.episodes.length > 1 ? episodeRange(item.episodes) : `Episode ${item.episodes[0]}`}</b>
                  {item.release.cached ? <span className="badge cached"><Zap size={12} fill="currentColor" />Instant</span> : <span className="badge">TorBox fetch</span>}
                </div>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <ResolutionBadge resolution={item.release.info.resolution} />
                  <div className="grow">
                    <div className="mono ellipsis" title={item.release.name}>{item.release.name}</div>
                    <div className="row wrap" style={{ gap: 6, marginTop: 6 }}><ReleaseTags release={item.release} season={season} /></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {(plan.missing.length > 0 || plan.skipped.length > 0) && (
            <div className="stack" style={{ gap: 8, marginTop: 14 }}>
              {plan.missing.length > 0 && <div className="notice warn">No release found for {episodeRange(plan.missing)}. You can search those episodes individually later.</div>}
              {plan.skipped.length > 0 && <div className="notice info">Skipping {episodeRange(plan.skipped)}: already in your library or not aired yet.</div>}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function EpisodeRow({ meta, episode, selected, onToggle, open, onOpen }: {
  meta: Meta; episode: Episode; selected: boolean; onToggle: () => void; open: boolean; onOpen: () => void;
}) {
  const download = useDownloader(meta);
  const upcoming = episode.released ? Date.parse(episode.released) > Date.now() + 12 * 3600_000 : false;
  const releases = useAsync(() => (open ? api.episodeReleases(meta.id, episode.season, episode.episode) : Promise.resolve(null)), [open]);
  return (
    <div className={`episode ${open ? 'open' : ''}`}>
      <button className={`check ${selected ? 'on' : ''}`} onClick={onToggle} disabled={upcoming} aria-label={`Select episode ${episode.episode}`}>
        {selected && <Check size={13} strokeWidth={3} />}
      </button>
      <div className="thumb">
        {episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />}
        <span className="num">E{pad(episode.episode)}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <h4 className="ellipsis">{episode.title}</h4>
        <div className="faint" style={{ fontSize: 12, marginBottom: 3 }}>{airDate(episode.released)}</div>
        {episode.overview && <p>{episode.overview}</p>}
      </div>
      <div className="side">
        {episode.owned && <span className="badge good"><CheckCircle2 size={12} />In library</span>}
        {upcoming && <span className="badge"><Clock size={12} />Not aired</span>}
        {!upcoming && <button className={`btn sm ${open ? '' : 'ghost'}`} onClick={onOpen}>{open ? <X size={14} /> : <Play size={14} />}{open ? 'Close' : 'Releases'}</button>}
      </div>
      {open && (
        <div className="episode-releases">
          {releases.loading && <div className="row muted" style={{ padding: 10 }}><span className="spinner" />Searching torrents for S{pad(episode.season)}E{pad(episode.episode)}…</div>}
          {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
          {releases.data && (
            <ReleaseList
              compact
              season={episode.season}
              releases={releases.data.releases}
              emptyText="No torrents found for this episode yet."
              onDownload={(release) => download([{ release, season: episode.season, episodes: [episode.episode] }], `${meta.name} S${pad(episode.season)}E${pad(episode.episode)}`)}
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
  const latestAired = [...seasons].reverse().find((season) => season > 0 && meta.episodes.some((episode) => episode.season === season && (!episode.released || Date.parse(episode.released) < Date.now())));
  const requested = search.has('season') ? Number(search.get('season')) : Number.NaN;
  const [season, setSeason] = useState<number>(seasons.includes(requested) ? requested : (latestAired ?? seasons[0] ?? 1));
  const [tab, setTab] = useState<'episodes' | 'packs'>('episodes');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openEpisode, setOpenEpisode] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ episodes?: number[] } | null>(null);
  const download = useDownloader(meta);

  const episodes = useMemo(() => meta.episodes.filter((episode) => episode.season === season), [meta, season]);
  const owned = episodes.filter((episode) => episode.owned).length;
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

  if (!episodes.length && !seasons.length) return <Empty icon={<Layers size={30} />} title="No episodes listed">The catalog doesn't list episodes for this show yet.</Empty>;

  return (
    <section>
      <div className="season-bar">
        <div className="chips">
          {seasons.map((value) => (
            <button key={value} className={`chip ${value === season ? 'on' : ''}`} onClick={() => chooseSeason(value)}>{value === 0 ? 'Specials' : `Season ${value}`}</button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>{episodes.length} episodes{owned ? ` · ${owned} in library` : ''}</div>
      </div>

      <div className="action-cards">
        <button className="action-card featured" onClick={() => setPlan({})}>
          <span className="icon-wrap"><Sparkles size={20} /></span>
          <span>
            <h3>Download the whole season</h3>
            <p>Haul grabs a season pack when a good one exists, otherwise every episode on its own. Episodes you already have are skipped.</p>
          </span>
        </button>
        <button className="action-card" onClick={() => setTab('packs')}>
          <span className="icon-wrap"><Layers size={20} /></span>
          <span>
            <h3>Pick a season pack</h3>
            <p>Compare every pack for Season {season} by quality, size and whether it's instant on TorBox.</p>
          </span>
        </button>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="segmented">
          <button className={tab === 'episodes' ? 'on' : ''} onClick={() => setTab('episodes')}>Episodes</button>
          <button className={tab === 'packs' ? 'on' : ''} onClick={() => setTab('packs')}>Season packs</button>
        </div>
        {tab === 'episodes' && (
          <button className="btn ghost sm" onClick={() => setSelected(selected.size ? new Set() : new Set(episodes.filter((episode) => !episode.owned && (!episode.released || Date.parse(episode.released) < Date.now())).map((episode) => episode.episode)))}>
            <ListChecks size={15} />{selected.size ? 'Clear selection' : 'Select missing'}
          </button>
        )}
      </div>

      {tab === 'episodes' && (
        <div className="episodes">
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
          {packs.loading && <div className="row muted" style={{ padding: 20 }}><span className="spinner" />Looking for Season {season} packs…</div>}
          {packs.error && <ErrorNote message={packs.error} onRetry={packs.reload} />}
          {packs.data && (
            <ReleaseList
              season={season}
              releases={packs.data.releases}
              emptyText={`No season packs found for Season ${season}. Use "Download the whole season" to grab each episode on its own.`}
              onDownload={(release) => download([{ release, season }], `${meta.name} · Season ${season} pack`)}
            />
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="select-bar">
          <b>{selected.size} selected</b>
          <span className="muted grow ellipsis">{episodeRange([...selected])}</span>
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn primary sm" onClick={() => setPlan({ episodes: [...selected].sort((a, b) => a - b) })}><Sparkles size={14} />Download selected</button>
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
      <div className="row" style={{ justifyContent: 'space-between', margin: '6px 0 14px' }}>
        <h2 className="section-title">Choose a release</h2>
        {meta.ownedMovie && <span className="badge good"><CheckCircle2 size={12} />Already in your library</span>}
      </div>
      {releases.loading && <div className="row muted" style={{ padding: 20 }}><span className="spinner" />Searching torrents and checking TorBox…</div>}
      {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
      {releases.data && <ReleaseList releases={releases.data.releases} onDownload={(release) => download([{ release }], meta.name)} />}
    </section>
  );
}

export function TitlePage({ type, id }: { type: MediaType; id: string }) {
  const { data: meta, error, reload } = useAsync(() => api.meta(type, id), [type, id]);
  const [logoFailed, setLogoFailed] = useState(false);
  if (error) return <div className="page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!meta) return <Loading />;
  return (
    <div className="page flush">
      <div className="title-hero">
        {meta.background && <div className="backdrop" style={{ backgroundImage: `url(${meta.background})` }} />}
        <button className="btn sm back-link" onClick={() => (window.history.length > 1 ? window.history.back() : undefined)}><ArrowLeft size={15} />Back</button>
        <div className="title-head">
          <Poster src={meta.poster} title={meta.name} owned={meta.inLibrary} />
          <div className="title-info">
            {meta.logo && !logoFailed ? <img className="logo" src={meta.logo} alt={meta.name} onError={() => setLogoFailed(true)} /> : <h1>{meta.name}</h1>}
            <div className="facts">
              {meta.imdbRating && <span className="star"><Star size={14} fill="currentColor" />{meta.imdbRating}</span>}
              {meta.releaseInfo && <span>{meta.releaseInfo}</span>}
              {meta.runtime && <span>{meta.runtime}</span>}
              {meta.type === 'series' && <span>{meta.seasons.filter((season) => season > 0).length} seasons</span>}
              {meta.genres?.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
              {meta.status && meta.type === 'series' && <span>{meta.status}</span>}
            </div>
            {meta.description && <p>{meta.description}</p>}
            {meta.cast?.length ? <div className="faint" style={{ fontSize: 13 }}>Starring {meta.cast.slice(0, 4).join(', ')}</div> : null}
          </div>
        </div>
      </div>
      <div className="title-body">
        {meta.type === 'series' ? <SeriesSection meta={meta} /> : <MovieSection meta={meta} />}
        <div style={{ marginTop: 26 }}><Link to="/" className="faint" style={{ fontSize: 12.5 }}>Back to Discover</Link></div>
      </div>
    </div>
  );
}
