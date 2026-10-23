import { Bell, BellRing } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Episode, Follow, Job, MediaType, Meta, Release, SeasonPlan } from '../../../shared/types';
import { api } from '../api';
import { Availability, Formats, ReleaseTable, packLine, sizeOf } from '../components/Releases';
import { Empty, ErrorNote, Loading, Menu, Picker, Sheet, TabBar, Tick, Toggle, join } from '../components/ui';
import { airDate, bytes, episodeRange, useAsync, usePolling, useRouter, useToast } from '../lib';
import { useCrumb } from '../shell';

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
  usePolling(() => { api.downloads().then(setData, () => undefined); }, 2000);
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
            </div>
          )}
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
            {plan.skipped.length > 0 && <div className="notice">Skipping {episodeRange(plan.skipped)}: already in your library or not out yet.</div>}
          </div>
        </>
      )}
    </Sheet>
  );
}

function EpisodeRow({ meta, episode, incoming, selected, onToggle, open, onOpen }: {
  meta: Meta; episode: Episode; incoming?: number; selected: boolean; onToggle: () => void; open: boolean; onOpen: () => void;
}) {
  const download = useDownloader(meta);
  const isAired = aired(episode);
  const releases = useAsync(() => (open ? api.episodeReleases(meta.id, episode.season, episode.episode) : Promise.resolve(null)), [open]);
  const status = episode.owned ? <span className="pill positive">In library</span>
    : incoming !== undefined ? <span className="pill transfer num">Downloading {Math.round(incoming * 100)}%</span>
      : !isAired ? <span className="pill">Out {airDate(episode.released)}</span>
        : <span className="faint">Not downloaded</span>;
  return (
    <div className={`trow tall ${open ? 'open' : ''}`} id={`episode-${episode.episode}`}>
      <Tick checked={selected} onChange={onToggle} disabled={!isAired || episode.owned} label={`Select episode ${episode.episode}`} />
      <div className="ident">
        <div className="thumb">{episode.thumbnail && <img src={episode.thumbnail} alt="" loading="lazy" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />}</div>
        <div style={{ minWidth: 0 }}>
          <div className="t1 truncate"><span className="faint num">{episode.episode}</span>&nbsp;&nbsp;{episode.title}</div>
          <div className="t2">{airDate(episode.released)}</div>
          {episode.overview && <div className="t3 clamp-2">{episode.overview}</div>}
        </div>
      </div>
      <span className="status">{status}</span>
      {isAired ? <button className="btn sm" style={{ justifySelf: 'end' }} onClick={onOpen}>{open ? 'Hide' : 'Versions'}</button> : <span />}
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
              onDownload={(release) => download([{ release, season: episode.season, episodes: [episode.episode] }], `${meta.name} ${seasonName(episode.season)}, episode ${episode.episode}`)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SeriesView({ meta }: { meta: Meta }) {
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
  const incoming = useIncoming(meta.id, season);

  const episodes = useMemo(() => meta.episodes.filter((episode) => episode.season === season), [meta, season]);
  const owned = episodes.filter((episode) => episode.owned);
  const missing = episodes.filter((episode) => !episode.owned && aired(episode) && !incoming.has(episode.episode));
  const packs = useAsync(() => (tab === 'packs' ? api.seasonPacks(meta.id, season) : Promise.resolve(null)), [tab, season, meta.id]);

  useEffect(() => { setSelected(new Set()); setOpenEpisode(null); }, [season]);
  // "Get" on Home's new-episodes list lands here and opens the plan for just those episodes.
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
    navigate(`/title/series/${meta.id}?season=${value}`, { replace: true });
  };
  const toggle = (episode: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(episode)) next.delete(episode); else next.add(episode);
    return next;
  });
  const pick = (episode: Episode) => {
    setTab('episodes');
    if (!episode.owned && aired(episode) && !incoming.has(episode.episode)) toggle(episode.episode);
    else document.getElementById(`episode-${episode.episode}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const downloadPack = (release: Release) => {
    // With nothing missing, a pack download is an upgrade: take every episode.
    const wanted = packSkipOwned && owned.length > 0 && missing.length > 0 ? missing.map((episode) => episode.episode) : undefined;
    return download([{ release, season, episodes: wanted }], `${meta.name}, ${seasonName(season)}`);
  };

  if (!seasons.length) return <Empty title="No episode list yet">The catalog doesn't list this show's episodes yet.</Empty>;

  const summary = !missing.length && owned.length
    ? `You have every episode that's out`
    : join([`${episodes.length} episodes`, owned.length ? `${owned.length} in your library` : '', incoming.size ? `${incoming.size} on the way` : '', missing.length ? `${missing.length} to get` : '']);

  return (
    <>
      <section className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <Picker label="Season" value={season} onChange={chooseSeason} options={seasons.map((value) => {
              const count = meta.episodes.filter((episode) => episode.season === value).length;
              return { value, label: seasonName(value), hint: `${count} ep` };
            })} />
            <span className="muted num">{summary}</span>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => setPlan({})} disabled={!missing.length}>
              {missing.length ? `Download ${seasonName(season).toLowerCase()}` : 'Season complete'}
            </button>
          </div>
        </div>
        <SeasonMap episodes={episodes} incoming={incoming} selected={selected} onPick={pick} />
      </section>

      <div style={{ marginTop: 26 }}>
        <TabBar value={tab} onChange={setTab} tabs={[{ value: 'episodes', label: 'Episodes', count: episodes.length }, { value: 'packs', label: 'Season packs' }]} />
      </div>

      {tab === 'episodes' && (
        <div className="table ep-table">
          <div className="thead">
            <span />
            <span className="row" style={{ justifyContent: 'space-between' }}>
              Episode
              {missing.length > 1 && (
                <button className="btn ghost sm" style={{ height: 24 }} onClick={() => setSelected(selected.size ? new Set() : new Set(missing.map((episode) => episode.episode)))}>
                  {selected.size ? 'Clear selection' : `Select all ${missing.length} missing`}
                </button>
              )}
            </span>
            <span>Status</span>
            <span />
          </div>
          {episodes.map((episode) => (
            <EpisodeRow
              key={episode.id}
              meta={meta}
              episode={episode}
              incoming={incoming.get(episode.episode)}
              selected={selected.has(episode.episode)}
              onToggle={() => toggle(episode.episode)}
              open={openEpisode === episode.episode}
              onOpen={() => setOpenEpisode(openEpisode === episode.episode ? null : episode.episode)}
            />
          ))}
        </div>
      )}

      {tab === 'packs' && (
        <div style={{ marginTop: 14 }}>
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
        </div>
      )}

      {selected.size > 0 && (
        <div className="selection">
          <span><b>{selected.size} selected</b> <span className="muted">{episodeRange([...selected])}</span></span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn primary" onClick={() => setPlan({ episodes: [...selected].sort((a, b) => a - b) })}>Download selected</button>
        </div>
      )}
      {plan && <PlanSheet meta={meta} season={season} episodes={plan.episodes} onClose={() => { setPlan(null); setSelected(new Set()); }} />}
    </>
  );
}

/** Follow a show or movie: Haul tells your phone when a torrent is out, and can download it right away. */
function FollowControl({ meta }: { meta: Meta }) {
  const toast = useToast();
  const { navigate } = useRouter();
  const [follow, setFollow] = useState<Follow | null>(meta.follow ?? null);
  const [asking, setAsking] = useState(false);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSeries = meta.type === 'series';

  const start = async () => {
    setBusy(true);
    try {
      const result = await api.follow(meta.type, meta.id, auto);
      setFollow(result.follow);
      setAsking(false);
      toast(result.notificationsReady
        ? `Following ${meta.name}. You'll get a notification as soon as ${isSeries ? 'a new episode' : 'it'} is out on torrent.`
        : <span>Following {meta.name}. Set up phone notifications in <a href="/settings" style={{ textDecoration: 'underline' }} onClick={(event) => { event.preventDefault(); navigate('/settings'); }}>Settings</a> to get alerts.</span>);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (follow) {
    return (
      <Menu
        label={`Following ${meta.name}`}
        trigger={<button className="btn"><BellRing size={15} />Following{follow.autoDownload ? ' · auto-download' : ''}</button>}
        actions={[
          { label: follow.autoDownload ? 'Stop downloading automatically' : `Download ${isSeries ? 'new episodes' : 'it'} automatically`, onSelect: async () => setFollow((await api.updateFollow(follow.id, !follow.autoDownload)).follow) },
          'separator',
          { label: 'Unfollow', danger: true, onSelect: async () => { await api.unfollow(follow.id); setFollow(null); toast(`Stopped following ${meta.name}`); } }
        ]}
      />
    );
  }

  return (
    <>
      <button className="btn" onClick={() => setAsking(true)}><Bell size={15} />Follow</button>
      <Sheet
        open={asking}
        onOpenChange={setAsking}
        title={`Follow ${meta.name}`}
        description={isSeries
          ? 'Haul checks the torrent sources for each new episode from the moment it airs (every 5 minutes on the first day) and notifies your phone as soon as one is out.'
          : 'Haul checks the torrent sources for this movie and notifies your phone as soon as a proper copy is out. Camera recordings are ignored.'}
        footer={
          <>
            <span className="hint">{isSeries ? 'Episodes already out more than 3 days are left to you.' : ''}</span>
            <div className="row">
              <button className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={start}>{busy && <span className="spinner" />}Follow</button>
            </div>
          </>
        }
      >
        <div className="panel" style={{ background: 'var(--raised)' }}>
          <div className="switch-row">
            <b>Download {isSeries ? 'new episodes' : 'it'} automatically</b>
            <Toggle checked={auto} onChange={setAuto} label="Download automatically" />
            <small>Haul takes the best version that meets your quality settings. If only a lower quality is out, it tells you and waits up to 12 hours for a better one.</small>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function MovieView({ meta }: { meta: Meta }) {
  const download = useDownloader(meta);
  const releases = useAsync(() => api.movieReleases(meta.id), [meta.id]);
  return (
    <section style={{ marginTop: 26 }} id="versions">
      <div className="section-title" style={{ marginTop: 0 }}><h2>Versions</h2>{releases.data && <span className="faint num">{releases.data.releases.length} found</span>}</div>
      {releases.loading && <Loading text="Searching torrents and checking TorBox…" />}
      {releases.error && <ErrorNote message={releases.error} onRetry={releases.reload} />}
      {releases.data && <ReleaseTable releases={releases.data.releases} onDownload={(release) => download([{ release }], meta.name)} />}
    </section>
  );
}

export function TitlePage({ type, id }: { type: MediaType; id: string }) {
  const { data: meta, error, reload } = useAsync(() => api.meta(type, id), [type, id]);
  useCrumb(meta?.name ?? null);
  const [noCover, setNoCover] = useState(false);
  if (error) return <div className="canvas"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!meta) return <Loading />;
  const seasonCount = meta.seasons.filter((season) => season > 0).length;
  return (
    <div className="canvas">
      <section className="card object">
        <div className="cover">{meta.poster && !noCover && <img src={meta.poster} alt="" onError={() => setNoCover(true)} />}</div>
        <div className="info">
          <h1>{meta.name}</h1>
          <div className="meta">{join([meta.type === 'series' ? `${seasonCount} season${seasonCount === 1 ? '' : 's'}` : 'Movie', meta.releaseInfo, meta.runtime, (meta.genres ?? []).slice(0, 3).join(', '), meta.imdbRating && `IMDb ${meta.imdbRating}`, meta.type === 'series' && meta.status])}</div>
          {meta.description && <p className="clamp-2">{meta.description}</p>}
          {meta.cast?.length ? <div className="faint" style={{ fontSize: 13 }}>{meta.cast.slice(0, 4).join(', ')}</div> : null}
          <div className="actions">
            {meta.type === 'movie' && <button className="btn primary" onClick={() => document.getElementById('versions')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{meta.ownedMovie ? 'Get another version' : 'Choose a version'}</button>}
            <FollowControl meta={meta} />
            {meta.ownedMovie && <span className="pill positive" style={{ alignSelf: 'center' }}>In your library</span>}
          </div>
        </div>
        <div className="still" style={meta.background ? { backgroundImage: `url(${meta.background})` } : undefined} aria-hidden="true" />
      </section>
      {meta.type === 'series' ? <SeriesView meta={meta} /> : <MovieView meta={meta} />}
    </div>
  );
}
