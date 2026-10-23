import { Check, Download, Ellipsis, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Job, MediaType, Meta, Release, SeasonPlan, WatchProgress } from '../../../shared/types';
import { api, preparePlay, previewOf } from '../api';
import { ListButton, TrailerButton } from '../components/Extras';
import { FollowControl } from '../components/Follow';
import { Hero } from '../components/Hero';
import { Availability, Formats, ReleaseTable, packLine, sizeOf } from '../components/Releases';
import { Empty, ErrorNote, Loading, Menu, Picker, PosterCard, Sheet, TabBar, Toggle, join } from '../components/ui';
import { Link, airDate, bytes, episodeRange, useAsync, usePolling, useRouter, useToast } from '../lib';
import { diskFor, useCrumb, useStatus } from '../shell';

const aired = (episode: Episode) => !episode.released || Date.parse(episode.released) <= Date.now() + 12 * 3600_000;
const seasonName = (season: number) => (season === 0 ? 'Specials' : `Season ${season}`);

function useDownloader(meta: Meta) {
  const toast = useToast();
  const { navigate } = useRouter();
  return async (items: Array<{ release: Release; season?: number; episodes?: number[] }>, label: string): Promise<boolean> => {
    try {
      if (items.length === 1) {
        await api.download({ type: meta.type, imdbId: meta.id, release: items[0]!.release, season: items[0]!.season, episodes: items[0]!.episodes });
      } else {
        await api.download({ type: meta.type, imdbId: meta.id, items: items.map((item) => ({ release: item.release, season: item.season!, episodes: item.episodes ?? [] })) });
      }
      window.dispatchEvent(new Event('haul:refresh-status'));
      toast(<span>{label} added to Downloads. <a href="/downloads" style={{ textDecoration: 'underline' }} onClick={(event) => { event.preventDefault(); navigate('/downloads'); }}>Open</a></span>);
      return true;
    } catch (error) {
      toast((error as Error).message, 'error');
      return false;
    }
  };
}

/** Progress (0–1) of each episode that is on its way, from the download queue. */
function useIncoming(imdbId: string, season?: number) {
  const { data, setData } = useAsync(() => api.downloads(), []);
  const busy = (data?.jobs ?? []).some((job) => job.imdbId === imdbId && ['queued', 'torbox', 'downloading'].includes(job.status));
  usePolling(() => { api.downloads().then(setData, () => undefined); }, busy ? 2000 : 15_000);
  return useMemo(() => {
    const incoming = new Map<number, number>();
    for (const job of (data?.jobs ?? []) as Job[]) {
      if (job.imdbId !== imdbId || job.season !== season || !['queued', 'torbox', 'downloading', 'paused'].includes(job.status)) continue;
      if (job.files.length) {
        for (const file of job.files) {
          if (file.kind !== 'video' || file.episode === undefined) continue;
          const done = file.status === 'done' || file.status === 'skipped' ? 1 : file.size ? file.downloaded / file.size : 0;
          for (let episode = file.episode; episode <= (file.episodeEnd ?? file.episode); episode += 1) incoming.set(episode, done);
        }
      } else {
        for (const episode of job.episodes ?? []) incoming.set(episode, 0);
      }
    }
    return incoming;
  }, [data, imdbId, season]);
}

function SeasonMap({ episodes, incoming, selected, onPick }: { episodes: Episode[]; incoming: Map<number, number>; selected: Set<number>; onPick: (episode: Episode) => void }) {
  return (
    <div>
      <div className="season-map" role="list" aria-label="Episodes in this season">
        {episodes.map((episode) => {
          const coming = incoming.get(episode.episode);
          const state = episode.owned ? 'owned' : coming !== undefined ? 'coming' : !aired(episode) ? 'unaired' : 'missing';
          const label = `Episode ${episode.episode}: ${episode.title}. ${state === 'owned' ? 'In your library' : state === 'coming' ? `Downloading, ${Math.round((coming ?? 0) * 100)}%` : state === 'unaired' ? `Out ${airDate(episode.released)}` : 'Not downloaded'}`;
          return (
            <button
              key={episode.id}
              role="listitem"
              className={`ep-cell ${state} ${selected.has(episode.episode) ? 'selected' : ''}`}
              title={label}
              aria-label={label}
              disabled={state === 'unaired'}
              onClick={() => onPick(episode)}
            >
              {state === 'coming' && <i style={{ width: `${Math.round((coming ?? 0) * 100)}%` }} />}
              <span>{episode.episode}</span>
            </button>
          );
        })}
      </div>
      <div className="map-legend">
        <span><i className="owned" />In your library</span>
        <span><i className="coming" />On its way</span>
        <span><i />Not downloaded</span>
        <span><i className="unaired" />Not out yet</span>
      </div>
    </div>
  );
}

function PlanSheet({ meta, season, episodes, onClose }: { meta: Meta; season: number; episodes?: number[]; onClose: () => void }) {
  const download = useDownloader(meta);
  const [skipOwned, setSkipOwned] = useState(true);
  const { data: plan, error, loading, reload } = useAsync<SeasonPlan>(() => api.planSeason(meta.id, season, episodes, skipOwned), [meta.id, season, skipOwned]);
  const [busy, setBusy] = useState(false);
  const count = plan ? plan.items.reduce((sum, item) => sum + item.episodes.length, 0) : 0;
  const disk = diskFor(useStatus(), 'Shows');
  const tooBig = Boolean(plan && disk && plan.totalSize > disk.free);

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    const ok = await download(plan.items.map((item) => ({ release: item.release, season, episodes: item.episodes })), `${meta.name}, ${seasonName(season)}`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`${meta.name}: ${seasonName(season)}${episodes?.length ? `, ${episodeRange(episodes)}` : ''}`}
      description="Haul takes one season pack when a good one is ready, and finds each remaining episode on its own."
      footer={
        <>
          <label className="row" style={{ cursor: 'pointer' }}>
            <Toggle checked={skipOwned} onChange={setSkipOwned} label="Skip episodes I have" />
            Skip episodes I have
          </label>
          <div className="row">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!plan || !count || busy} onClick={start}>
              {busy && <span className="spinner" />}Download {count} episode{count === 1 ? '' : 's'}
            </button>
          </div>
        </>
      }
    >
      {loading && <Loading text="Comparing season packs and single episodes…" />}
      {error && <ErrorNote message={error} onRetry={reload} />}
      {plan && !loading && (
        <>
          {plan.items.length > 0 && (
            <div className="plan-figure">
              <div><b>{count}</b><span>episodes</span></div>
              <div><b>{plan.totalSize ? bytes(plan.totalSize) : '–'}</b><span>about this much</span></div>
              <div><b>{plan.cachedCount}</b><span>ready now on TorBox</span></div>
              {disk && <div><b>{bytes(disk.free)}</b><span>free on the disk</span></div>}
            </div>
          )}
          {tooBig && <div className="notice warning" style={{ marginBottom: 12 }}>This is more than the {bytes(disk!.free)} free on the disk for shows. Haul downloads what fits and waits for space before each remaining file.</div>}
          {!plan.items.length && <Empty title="Nothing to download">{plan.skipped.length ? 'You already have every episode that is out.' : 'No releases were found for this season.'}</Empty>}
          <div className="table rel-table">
            {plan.items.map((item) => (
              <div key={item.release.hash} className="trow" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <span className="t1">{item.episodes.length > 1 ? `Episodes ${episodeRange(item.episodes).replace(/E/g, '')}` : `Episode ${item.episodes[0]}`}</span>
                    <Formats info={item.release.info} />
                  </div>
                  <div className="release-name">{join([packLine(item.release, season), item.release.name])}</div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <span className="num muted">{sizeOf(item.release)}</span>
                  <Availability cached={item.release.cached} />
                </div>
              </div>
            ))}
          </div>
          <div className="stack" style={{ marginTop: 12, gap: 8 }}>
            {plan.missing.length > 0 && <div className="notice warning">No release found for {episodeRange(plan.missing)}. Try those episodes on their own later.</div>}
            {plan.skipped.length > 0 && <div className="notice">Skipping {episodeRange(plan.skipped)}: already in your library, downloading, or not out yet.</div>}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Plans every season with episodes you don't have, one season at a time, then downloads them all together. */
function EverythingSheet({ meta, seasons, onClose }: { meta: Meta; seasons: number[]; onClose: () => void }) {
  const download = useDownloader(meta);
  const disk = diskFor(useStatus(), 'Shows');
  const [plans, setPlans] = useState<Array<{ season: number; plan?: SeasonPlan; error?: string }>>(() => seasons.map((season) => ({ season })));
  const [busy, setBusy] = useState(false);

  const alive = useRef(true);
  const planOne = async (season: number) => {
    setPlans((current) => current.map((entry) => (entry.season === season ? { season } : entry)));
    const result = await api.planSeason(meta.id, season, undefined, true).then((plan) => ({ plan }), (error: Error) => ({ error: error.message }));
    if (alive.current) setPlans((current) => current.map((entry) => (entry.season === season ? { season, ...result } : entry)));
  };
  useEffect(() => {
    alive.current = true;
    (async () => { for (const season of seasons) if (alive.current) await planOne(season); })();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = plans.filter((entry) => entry.plan || entry.error).length;
  const planning = done < plans.length;
  const ready = plans.filter((entry) => entry.plan?.items.length);
  const episodes = ready.reduce((sum, entry) => sum + entry.plan!.items.reduce((count, item) => count + item.episodes.length, 0), 0);
  const size = ready.reduce((sum, entry) => sum + entry.plan!.totalSize, 0);
  const cached = ready.reduce((sum, entry) => sum + entry.plan!.cachedCount, 0);

  const start = async () => {
    setBusy(true);
    const items = ready.flatMap((entry) => entry.plan!.items.map((item) => ({ release: item.release, season: entry.season, episodes: item.episodes })));
    const ok = await download(items, `${meta.name}, ${ready.length} season${ready.length === 1 ? '' : 's'}`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Everything missing from ${meta.name}`}
      description="Haul plans each season the same way as Download season: a good pack when one is ready, otherwise the best release for each episode. Episodes you have or that are already downloading are skipped."
      footer={
        <>
          <span className="hint">{planning ? `Planning season ${plans[done]?.season ?? ''}, ${done} of ${plans.length} done…` : ''}</span>
          <div className="row">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={planning || !episodes || busy} onClick={start}>
              {(busy || planning) && <span className="spinner" />}{planning ? 'Planning…' : `Download ${episodes} episode${episodes === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      }
    >
      <div className="plan-figure">
        <div><b>{episodes}</b><span>episodes</span></div>
        <div><b>{size ? bytes(size) : '–'}</b><span>about this much</span></div>
        <div><b>{cached}</b><span>ready now on TorBox</span></div>
        {disk && <div><b>{bytes(disk.free)}</b><span>free on the disk</span></div>}
      </div>
      <div className="plan-progress" aria-hidden="true"><i style={{ width: `${(done / Math.max(1, plans.length)) * 100}%` }} /></div>
      {!planning && disk && size > disk.free && <div className="notice warning" style={{ marginBottom: 12 }}>This is more than the {bytes(disk.free)} free on the disk for shows. Haul downloads what fits and waits for space before each remaining file.</div>}
      <div className="table">
        {plans.map(({ season, plan, error }) => {
          const count = plan?.items.reduce((sum, item) => sum + item.episodes.length, 0) ?? 0;
          const packs = plan?.items.filter((item) => item.release.kind === 'season' || item.release.kind === 'multi-season').length ?? 0;
          return (
            <div key={season} className="trow" style={{ gridTemplateColumns: '110px minmax(0, 1fr) auto' }}>
              <span className="t1">{seasonName(season)}</span>
              <span className="muted truncate" style={{ fontSize: 13 }}>
                {error ? error
                  : !plan ? 'Waiting…'
                    : !count ? (plan.missing.length ? `No releases found for ${episodeRange(plan.missing)}` : 'Nothing to get')
                      : join([`${count} episode${count === 1 ? '' : 's'}`, packs ? (plan.items.length === 1 ? 'one pack' : `${packs} pack${packs === 1 ? '' : 's'}`) : `${plan.items.length} torrent${plan.items.length === 1 ? '' : 's'}`, plan.totalSize ? bytes(plan.totalSize) : '', plan.missing.length ? `${plan.missing.length} not found` : ''])}
              </span>
              {plan && count > 0 ? <Availability cached={plan.cachedCount === count} />
                : error ? <button className="btn sm" onClick={() => void planOne(season)}>Try again</button>
                  : !plan ? <span className="spinner" /> : <span />}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

const minutesLeft = (entry: WatchProgress) => Math.max(1, Math.round((entry.duration - entry.position) / 60));
const isWatched = (entry?: WatchProgress) => Boolean(entry && entry.duration > 0 && entry.position / entry.duration >= 0.92);

/** One episode in the watch list: press the picture or the name to play it. */
function EpisodeRow({ meta, episode, incoming, progress, open, onOpen, onWatched }: {
  meta: Meta; episode: Episode; incoming?: number; progress?: WatchProgress; open: boolean; onOpen: () => void; onWatched: (watched: boolean) => void;
}) {
  const download = useDownloader(meta);
  const { navigate } = useRouter();
  const isAired = aired(episode);
  const releases = useAsync(() => (open ? api.episodeReleases(meta.id, episode.season, episode.episode) : Promise.resolve(null)), [open]);
  const watch = `/watch/series/${meta.id}?s=${episode.season}&e=${episode.episode}`;
  const watched = isWatched(progress);
  const started = progress && !watched && progress.position > 30;
  const still = episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />;
  return (
    <div className={`episode ${open ? 'open' : ''} ${isAired ? '' : 'unaired'}`} id={`episode-${episode.episode}`}>
      {isAired ? (
        <Link to={watch} className="episode-still" onPointerEnter={() => { if (!episode.owned) preparePlay({ type: 'series', imdbId: meta.id, season: episode.season, episode: episode.episode }, true); }} aria-label={`${started ? 'Resume' : 'Play'} episode ${episode.episode}, ${episode.title}`}>
          {still}
          <span className="play-badge"><Play size={18} fill="currentColor" /></span>
          {started && <i className="watched" aria-hidden="true"><b style={{ width: `${Math.min(100, (progress!.position / progress!.duration) * 100)}%` }} /></i>}
          {watched && <span className="seen" title="Watched"><Check size={13} strokeWidth={3} /></span>}
        </Link>
      ) : <div className="episode-still">{still}</div>}
      <div className="episode-body">
        <div className="episode-head">
          {isAired ? <Link to={watch} className="episode-name"><span className="faint num">{episode.episode}.</span> {episode.title}</Link> : <span className="episode-name"><span className="faint num">{episode.episode}.</span> {episode.title}</span>}
        </div>
        <div className="episode-facts">
          {join([airDate(episode.released), meta.runtime])}
          {watched && <span className="tag">Watched</span>}
          {started && <span className="tag">{minutesLeft(progress!)} min left</span>}
          {episode.owned && <span className="tag positive">In your library</span>}
          {incoming !== undefined && <span className="tag transfer num">Downloading {Math.round(incoming * 100)}%</span>}
          {!isAired && <span className="tag">Out {airDate(episode.released)}</span>}
        </div>
        {episode.overview && <p className="episode-overview">{episode.overview}</p>}
      </div>
      {isAired && (
        <div className="episode-actions">
          <button className={`btn sm icon ${watched ? 'watched-on' : 'ghost'}`} onClick={() => onWatched(!watched)} aria-pressed={watched} aria-label={watched ? `Episode ${episode.episode} watched. Mark as not watched` : `Mark episode ${episode.episode} as watched`} title={watched ? 'Watched. Press to mark as not watched' : 'Mark as watched'}><Check size={14} strokeWidth={watched ? 3 : 2} /></button>
          <button className={`btn sm ${open ? '' : 'ghost'}`} onClick={onOpen} aria-expanded={open}>
            <Download size={14} />{open ? 'Hide versions' : 'Versions'}
          </button>
        </div>
      )}
      {open && (
        <div className="expand">
          {releases.loading && <Loading text={`Looking for episode ${episode.episode}…`} />}
          {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
          {releases.data && (
            <ReleaseTable
              compact
              season={episode.season}
              releases={releases.data.releases}
              emptyText="No torrents for this episode yet."
              onStream={(release) => navigate(`${watch}&hash=${release.hash}`)}
              onDownload={(release) => download([{ release, season: episode.season, episodes: [episode.episode] }], `${meta.name} ${seasonName(episode.season)}, episode ${episode.episode}`)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SeriesView({ meta, onWatched }: { meta: Meta; onWatched: () => void }) {
  const { search, navigate } = useRouter();
  const seasons = meta.seasons.filter((season) => season > 0).concat(meta.seasons.includes(0) ? [0] : []);
  const latestAired = [...seasons].reverse().find((season) => season > 0 && meta.episodes.some((episode) => episode.season === season && aired(episode)));
  const requested = search.has('season') ? Number(search.get('season')) : Number.NaN;
  const [season, setSeason] = useState<number>(seasons.includes(requested) ? requested : (latestAired ?? seasons[0] ?? 1));
  const [tab, setTab] = useState<'episodes' | 'download'>(search.get('tab') === 'packs' || search.get('tab') === 'download' ? 'download' : 'episodes');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openEpisode, setOpenEpisode] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ episodes?: number[] } | null>(null);
  const [everything, setEverything] = useState(false);
  const [packSkipOwned, setPackSkipOwned] = useState(true);
  const download = useDownloader(meta);
  const incoming = useIncoming(meta.id, season);
  const watched = useAsync(() => api.progressFor('series', meta.id).catch(() => ({ items: [] as WatchProgress[] })), [meta.id]);

  const episodes = useMemo(() => meta.episodes.filter((episode) => episode.season === season), [meta, season]);
  const owned = episodes.filter((episode) => episode.owned);
  const missing = episodes.filter((episode) => !episode.owned && aired(episode) && !incoming.has(episode.episode));
  const progressOf = useMemo(() => {
    const map = new Map<string, WatchProgress>();
    for (const entry of watched.data?.items ?? []) map.set(`${entry.season}:${entry.episode}`, entry);
    return map;
  }, [watched.data]);
  const packs = useAsync(() => (tab === 'download' ? api.seasonPacks(meta.id, season) : Promise.resolve(null)), [tab, season, meta.id]);
  const toast = useToast();
  /** Marks episodes watched or not without playing them; the list updates at once and settles on the server's answer. */
  const markWatched = async (picked: Episode[], seen: boolean, announce?: string) => {
    if (!picked.length) return;
    try {
      const result = await api.markWatched({ type: 'series', imdbId: meta.id, title: meta.name, poster: meta.poster, background: meta.background, episodes: picked.map((entry) => ({ season: entry.season, episode: entry.episode, title: entry.title })), watched: seen });
      watched.setData(result);
      onWatched();
      if (announce) toast(announce);
    } catch (failure) {
      toast((failure as Error).message, 'error');
    }
  };

  useEffect(() => { setSelected(new Set()); setOpenEpisode(null); }, [season]);
  // "Download" on Home's new-episodes list lands here and opens the plan for just those episodes.
  useEffect(() => {
    if (search.get('get') !== 'new') return;
    const lastOwned = Math.max(0, ...owned.map((episode) => episode.episode));
    const fresh = missing.filter((episode) => episode.episode > lastOwned).map((episode) => episode.episode);
    if (fresh.length) setPlan({ episodes: fresh });
    navigate(`/title/series/${meta.id}?season=${season}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseSeason = (value: number) => {
    setSeason(value);
    navigate(`/title/series/${meta.id}?season=${value}${tab === 'download' ? '&tab=download' : ''}`, { replace: true });
  };
  const toggle = (episode: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(episode)) next.delete(episode); else next.add(episode);
    return next;
  });
  const pick = (episode: Episode) => {
    if (!episode.owned && aired(episode) && !incoming.has(episode.episode)) toggle(episode.episode);
  };
  const downloadPack = (release: Release) => {
    // With nothing missing, a pack download is an upgrade: take every episode.
    const wanted = packSkipOwned && owned.length > 0 && missing.length > 0 ? missing.map((episode) => episode.episode) : undefined;
    return download([{ release, season, episodes: wanted }], `${meta.name}, ${seasonName(season)}`);
  };

  if (!seasons.length) return <Empty title="No episode list yet">The catalog doesn't list this show's episodes yet.</Empty>;

  // Seasons (not specials) with episodes that are out and not in the library.
  const seasonsMissing = seasons.filter((value) => value > 0 && meta.episodes.some((episode) => episode.season === value && !episode.owned && aired(episode)));
  const seenCount = episodes.filter((episode) => isWatched(progressOf.get(`${episode.season}:${episode.episode}`))).length;
  const summary = join([`${episodes.length} episodes`, seenCount ? `${seenCount} watched` : '', owned.length ? `${owned.length} in your library` : '', incoming.size ? `${incoming.size} downloading` : '']);

  return (
    <>
      <div className="season-bar">
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <Picker label="Season" value={season} onChange={chooseSeason} options={seasons.map((value) => {
            const count = meta.episodes.filter((episode) => episode.season === value).length;
            return { value, label: seasonName(value), hint: `${count} ep` };
          })} />
          <span className="muted num">{summary}</span>
          <Menu
            label={`More for ${seasonName(season)}`}
            trigger={<button className="btn ghost sm icon" aria-label={`More for ${seasonName(season)}`}><Ellipsis size={16} /></button>}
            actions={[
              { label: `Mark ${seasonName(season).toLowerCase()} as watched`, onSelect: () => void markWatched(episodes.filter(aired), true, `${seasonName(season)} marked as watched`), disabled: !episodes.some(aired) },
              { label: `Mark ${seasonName(season).toLowerCase()} as not watched`, onSelect: () => void markWatched(episodes, false, `${seasonName(season)} marked as not watched`), disabled: !seenCount }
            ]}
          />
        </div>
        <TabBar value={tab} onChange={(value) => { setTab(value); navigate(`/title/series/${meta.id}?season=${season}${value === 'download' ? '&tab=download' : ''}`, { replace: true }); }} tabs={[{ value: 'episodes', label: 'Episodes' }, { value: 'download', label: 'Download' }]} />
      </div>

      {tab === 'episodes' && (
        <div className="episode-list">
          {episodes.map((episode) => (
            <EpisodeRow
              key={episode.id}
              meta={meta}
              episode={episode}
              incoming={incoming.get(episode.episode)}
              progress={progressOf.get(`${episode.season}:${episode.episode}`)}
              open={openEpisode === episode.episode}
              onOpen={() => setOpenEpisode(openEpisode === episode.episode ? null : episode.episode)}
              onWatched={(value) => void markWatched([episode], value)}
            />
          ))}
        </div>
      )}

      {tab === 'download' && (
        <>
          <section className="card" style={{ marginTop: 14 }}>
            <div className="card-head" style={{ flexWrap: 'wrap' }}>
              <div>
                <h2>Download {seasonName(season).toLowerCase()}</h2>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>{missing.length ? `${missing.length} episode${missing.length === 1 ? '' : 's'} not in your library. Tap squares to pick some, or take the whole season.` : 'Every episode that is out is in your library.'}</p>
              </div>
              <div className="row">
                {seasonsMissing.length > 1 && <button className="btn" onClick={() => setEverything(true)}>Get all {seasonsMissing.length} seasons</button>}
                <button className="btn primary" onClick={() => setPlan({})} disabled={!missing.length}>
                  {missing.length ? `Download ${seasonName(season).toLowerCase()}` : 'Season complete'}
                </button>
              </div>
            </div>
            <SeasonMap episodes={episodes} incoming={incoming} selected={selected} onPick={pick} />
          </section>

          <div className="section-title"><h2>Season packs</h2></div>
          {owned.length > 0 && missing.length > 0 && (
            <label className="row" style={{ marginBottom: 12, cursor: 'pointer' }}>
              <Toggle checked={packSkipOwned} onChange={setPackSkipOwned} label="Only take episodes I don't have" />
              Only take the {missing.length} episode{missing.length === 1 ? '' : 's'} I don't have
            </label>
          )}
          {packs.loading && <Loading text={`Looking for ${seasonName(season).toLowerCase()} packs…`} />}
          {packs.error && <ErrorNote message={packs.error} onRetry={packs.reload} />}
          {packs.data && (
            <ReleaseTable
              season={season}
              releases={packs.data.releases}
              emptyText={`No packs for ${seasonName(season).toLowerCase()}. "Download ${seasonName(season).toLowerCase()}" finds each episode on its own instead.`}
              onDownload={downloadPack}
            />
          )}

          {selected.size > 0 && (
            <div className="selection">
              <span><b>{selected.size} selected</b> <span className="muted">{episodeRange([...selected])}</span></span>
              <span className="grow" />
              <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="btn primary" onClick={() => setPlan({ episodes: [...selected].sort((a, b) => a - b) })}>Download selected</button>
            </div>
          )}
        </>
      )}
      {plan && <PlanSheet meta={meta} season={season} episodes={plan.episodes} onClose={() => { setPlan(null); setSelected(new Set()); }} />}
      {everything && <EverythingSheet meta={meta} seasons={seasonsMissing} onClose={() => setEverything(false)} />}
    </>
  );
}

function MovieView({ meta }: { meta: Meta }) {
  const download = useDownloader(meta);
  const { navigate } = useRouter();
  const releases = useAsync(() => api.movieReleases(meta.id), [meta.id]);
  return (
    <section style={{ marginTop: 30 }} id="versions">
      <div className="section-title" style={{ marginTop: 0 }}>
        <div>
          <h2>Versions</h2>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>Press ▶ to watch one now from TorBox, or download it to your library.</p>
        </div>
        {releases.data && <span className="faint num" style={{ whiteSpace: 'nowrap' }}>{releases.data.releases.length} found</span>}
      </div>
      {releases.loading && <Loading text="Searching torrents and checking TorBox…" />}
      {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
      {releases.data && <ReleaseTable releases={releases.data.releases} onStream={(release) => navigate(`/watch/movie/${meta.id}?hash=${release.hash}`)} onDownload={(release) => download([{ release }], meta.name)} />}
    </section>
  );
}

/** Play, Resume, or Play S01E01: your file when you have it, otherwise streamed from TorBox. */
function PlayButton({ meta, resume }: { meta: Meta; resume?: WatchProgress }) {
  const first = meta.episodes.filter((episode) => episode.season > 0 && aired(episode)).sort((a, b) => a.season - b.season || a.episode - b.episode)[0];
  const target = meta.type === 'series' ? (resume ? { season: resume.season!, episode: resume.episode! } : first) : undefined;
  const play = { type: meta.type, imdbId: meta.id, season: target?.season, episode: target?.episode };
  // Opening the page gets the stream going at TorBox (which takes a few seconds to convert the first
  // part), so Play is usually instant by the time it's pressed. Only versions already in the TorBox list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!meta.ownedMovie && (meta.type === 'movie' || target)) preparePlay(play, true); }, [meta.id, target?.season, target?.episode]);
  if (meta.type === 'series' && !target) return null;
  const code = target ? `S${String(target.season).padStart(2, '0')}E${String(target.episode).padStart(2, '0')}` : ''; // taste-skill-ignore: episode code
  const resuming = resume && !resume.upNext && resume.position > 30;
  const label = resuming ? `Resume${code ? ` ${code}` : ''}` : `Play${code ? ` ${code}` : ''}`;
  const to = meta.type === 'series' ? `/watch/series/${meta.id}?s=${target!.season}&e=${target!.episode}` : `/watch/movie/${meta.id}`;
  return (
    <Link to={to} className="btn primary lg" onPointerEnter={() => preparePlay(play, true)} onFocus={() => preparePlay(play, true)} onPointerDown={() => preparePlay(play, true)}>
      <Play size={17} fill="currentColor" />{label}
      {resuming && resume.duration > 0 && <span className="btn-meta">{minutesLeft(resume)} min left</span>}
    </Link>
  );
}

/**
 * Popular titles that share the most genres with this one. Fetched only when the row comes near the
 * screen, so opening a title costs nothing extra.
 */
function MoreLikeThis({ meta }: { meta: Meta }) {
  const anchor = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = anchor.current;
    if (!node || near) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  const genres = (meta.genres ?? []).slice(0, 2);
  const similar = useAsync(async () => {
    if (!near || !genres.length) return [];
    const lists = await Promise.all(genres.map((genre) => api.catalog(meta.type, 'top', { genre }).then((result) => result.items, () => [])));
    const shared = (item: { genres?: string[] }) => (item.genres ?? []).filter((genre) => meta.genres?.includes(genre)).length;
    const seen = new Set([meta.id]);
    const merged = lists.flat().filter((item) => !seen.has(item.id) && seen.add(item.id));
    // Most genres in common first; the catalog's own popularity order breaks ties.
    return merged.map((item, order) => ({ item, order, score: shared(item) })).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 18).map(({ item }) => item);
  }, [near, meta.id]);
  return (
    <section ref={anchor} className="more-like">
      {similar.data && similar.data.length > 0 && (
        <>
          <div className="section-title"><h2>More like this</h2></div>
          <div className="shelf">{similar.data.map((item) => <PosterCard key={item.id} item={item} />)}</div>
        </>
      )}
    </section>
  );
}

/** A film's "…" menu: mark it watched (or not) without playing it. */
function MovieMore({ meta, onWatched }: { meta: Meta; onWatched: () => void }) {
  const toast = useToast();
  const progress = useAsync(() => api.progressFor('movie', meta.id).catch(() => ({ items: [] as WatchProgress[] })), [meta.id]);
  const seen = isWatched(progress.data?.items[0]);
  const mark = async (watched: boolean) => {
    try {
      progress.setData(await api.markWatched({ type: 'movie', imdbId: meta.id, title: meta.name, poster: meta.poster, background: meta.background, watched }));
      onWatched();
      toast(watched ? `${meta.name} marked as watched` : `${meta.name} marked as not watched`);
    } catch (failure) {
      toast((failure as Error).message, 'error');
    }
  };
  return (
    <Menu
      label={`More for ${meta.name}`}
      trigger={<button className="btn glass icon" aria-label={`More for ${meta.name}`}><Ellipsis size={17} /></button>}
      actions={[seen ? { label: 'Mark as not watched', onSelect: () => void mark(false) } : { label: 'Mark as watched', onSelect: () => void mark(true) }]}
    />
  );
}

export function TitlePage({ type, id }: { type: MediaType; id: string }) {
  const { data: meta, error, reload } = useAsync(() => api.meta(type, id), [type, id]);
  const resume = useAsync(() => api.continueWatching().catch(() => ({ items: [] as WatchProgress[] })), [type, id]);
  const preview = previewOf(type, id);
  useCrumb(meta?.name ?? preview?.name ?? null);
  if (error) return <div className="canvas"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!meta) {
    return (
      <div className="canvas title-page">
        {preview?.background
          ? <Hero size="medium" background={preview.background} logo={preview.logo} title={preview.name} description={preview.description}
              facts={join([preview.type === 'series' ? 'Series' : 'Movie', preview.releaseInfo, (preview.genres ?? []).slice(0, 3).join(', '), preview.imdbRating && `IMDb ${preview.imdbRating}`])} />
          : <div className="hero medium skeleton-hero" />}
        <Loading />
      </div>
    );
  }
  const seasonCount = meta.seasons.filter((season) => season > 0).length;
  const entry = resume.data?.items.find((item) => item.imdbId === meta.id && item.type === meta.type);
  const toVersions = () => document.getElementById('versions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="canvas title-page">
      <Hero
        size="medium"
        background={meta.background}
        logo={meta.logo}
        title={meta.name}
        facts={join([meta.type === 'series' ? `${seasonCount} season${seasonCount === 1 ? '' : 's'}` : 'Movie', meta.releaseInfo, meta.runtime, (meta.genres ?? []).slice(0, 3).join(', '), meta.imdbRating && `IMDb ${meta.imdbRating}`, meta.type === 'series' && meta.status])}
        description={meta.description}
        footer={meta.cast?.length ? <div className="hero-cast">Starring {meta.cast.slice(0, 4).join(', ')}</div> : null}
      >
        {resume.data && <PlayButton meta={meta} resume={entry} />}
        <TrailerButton url={meta.trailer} title={meta.name} />
        <ListButton item={{ type: meta.type, imdbId: meta.id, title: meta.name, poster: meta.poster, background: meta.background, releaseInfo: meta.releaseInfo }} initial={Boolean(meta.inList)} />
        <FollowControl target={{ type: meta.type, imdbId: meta.id, title: meta.name }} initial={meta.follow ?? null} />
        {meta.type === 'movie' && <button className="btn glass" onClick={toVersions}><Download size={15} />{meta.ownedMovie ? 'Other versions' : 'Download'}</button>}
        {meta.type === 'movie' && <MovieMore meta={meta} onWatched={resume.reload} />}
        {meta.ownedMovie && <span className="pill positive" style={{ alignSelf: 'center' }}>In your library</span>}
      </Hero>
      {meta.type === 'series' ? <SeriesView key={meta.id} meta={meta} onWatched={resume.reload} /> : <MovieView meta={meta} />}
      <MoreLikeThis key={`more-${meta.id}`} meta={meta} />
    </div>
  );
}
