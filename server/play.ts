import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { LibraryFile, MediaType, Meta, PlayCaps, PlaySession, PlaySubtitle, Release, WatchProgress } from '../shared/types.js';
import type * as catalog from './catalog.js';
import { type Context, HttpError, type Router, sendFile } from './http.js';
import type { Library } from './library.js';
import { type Caps, HlsJobs, type MediaTools, type Probe, chooseMode, defaultAudio, languageName, srtToVtt, trackLabel, videoPlays } from './media.js';
import { type ProgressStore, isFinished, progressKey } from './progress.js';
import { VIDEO_EXTENSIONS, extensionOf, isExtraFile, isForeignOnly, parseEpisodeFile, parseRelease } from './release.js';
import type { SearchService } from './search.js';
import { type Debrid, DebridError, type DebridFile, type DebridTorrent, type ServiceStream, type Services } from './debrid.js';
import { magnetFor } from './torbox.js';

interface Deps {
  library: Library;
  catalog: typeof catalog;
  search: SearchService;
  debrid: Services;
  media: MediaTools;
  /** The watching of whoever this browser is (profiles). */
  progress: (ctx: Context) => ProgressStore;
  apiKey: () => string;
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * For playing without asking: 0 an English (or untagged) release, 1 one with several languages,
 * 2 dubbed only. A multi-language release often starts on the dub, so it comes second.
 */
export function languageTier(info: Release['info']): number {
  const languages = info.languages.filter((language) => language !== 'EN');
  if (!languages.length) return 0;
  return isForeignOnly(info) ? 2 : 1;
}

const HOUR = 3_600_000;

/** The languages you last picked in the player ("English", "Japanese"); subtitles undefined means off. */
interface Wants { audio?: string; subtitles?: string }
function wantsFrom(body: Record<string, unknown>): Wants {
  const name = (value: unknown) => (typeof value === 'string' && value.trim() ? languageName(value.slice(0, 40)) : undefined);
  return { audio: name(body.audioLanguage), subtitles: name(body.subtitleLanguage) };
}

/** The track in your language: a full one before a "forced" (signs only) one. */
export function trackFor<T extends { language?: string | null; title?: string | null; forced?: boolean }>(tracks: T[], language?: string): number {
  if (!language) return -1;
  const matching = tracks.map((track, position) => ({ track, position })).filter(({ track }) => languageName(track.language) === language);
  const full = matching.find(({ track }) => !track.forced && !/forced|signs/i.test(track.title ?? ''));
  return (full ?? matching[0])?.position ?? -1;
}

/** "0:22:22.078000" → 1342.078 */
export function clockSeconds(value?: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value ?? '');
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}

/**
 * Points a TorBox playlist at the right places for a browser: segments go straight to TorBox's CDN
 * (their URLs carry a per-stream token, not the API key); nested playlists come back through Haul,
 * which adds the key. Any query parameter equal to the API key is removed.
 */
export function rewritePlaylist(text: string, upstream: string, secret: string, proxy: (absolute: string) => string): string {
  const clean = (value: string) => {
    const absolute = new URL(value, upstream);
    for (const [name, param] of [...absolute.searchParams]) if (secret && param === secret) absolute.searchParams.delete(name);
    return absolute.pathname.endsWith('.m3u8') ? proxy(absolute.toString()) : absolute.toString();
  };
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return clean(line.trim());
    return line.replace(/URI="([^"]+)"/g, (_whole, uri: string) => `URI="${clean(uri)}"`);
  }).join('\n');
}

/** The next episode that's out: later in the season, else the first of the next season. */
export function nextEpisode(meta: Meta, season: number, episode: number): { season: number; episode: number; title: string } | undefined {
  const aired = (released?: string) => !released || Date.parse(released) <= Date.now();
  const ordered = meta.episodes.filter((entry) => entry.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode);
  const index = ordered.findIndex((entry) => entry.season === season && entry.episode === episode);
  const next = index >= 0 ? ordered[index + 1] : undefined;
  return next && aired(next.released) ? { season: next.season, episode: next.episode, title: next.title } : undefined;
}

function capsFrom(value: unknown): Caps {
  const caps = (value && typeof value === 'object' ? value : {}) as Partial<PlayCaps>;
  return { hevc: caps.hevc === true, av1: caps.av1 === true, ac3: caps.ac3 === true };
}

/** A file Haul plays itself: one on this machine, or (remote) a debrid service's link to one. */
interface LocalSession { kind: 'local'; file: LibraryFile; probe: Probe | null; caps: Caps; audio: number; at: number; remote?: boolean }
interface TorboxSession { kind: 'torbox'; torrentId: number | string; fileId: number; upstream: string; audio: number; subtitle: number | null; at: number }

/** What pressing play found on the debrid service: TorBox's own stream, or a link Haul plays itself. */
type ServiceFind =
  | { kind: 'torbox'; name: string; torrent: DebridTorrent; target: DebridFile; stream: ServiceStream; audio: number; subtitle: number | null }
  | { kind: 'remote'; name: string; torrent: DebridTorrent; target: DebridFile; link: string; service: Debrid };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Passes a byte range of a debrid link through to the browser (links stay on the server). */
async function proxyRemote(ctx: Context, url: string): Promise<void> {
  const controller = new AbortController();
  ctx.req.on('close', () => controller.abort());
  const upstream = await fetch(url, { headers: { ...(ctx.req.headers.range ? { Range: String(ctx.req.headers.range) } : {}), 'User-Agent': 'Haul/1.0' }, signal: controller.signal })
    .catch((error: Error) => { throw new HttpError(502, `The service didn't send the video: ${error.message}`); });
  if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, `The service didn't send the video (${upstream.status}). Press play again.`);
  const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' };
  for (const name of ['content-length', 'content-range']) { const value = upstream.headers.get(name); if (value) headers[name] = value; }
  ctx.res.writeHead(upstream.status, headers);
  if (ctx.req.method === 'HEAD' || !upstream.body) { ctx.res.end(); controller.abort(); return; }
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => ctx.res.destroy()).pipe(ctx.res);
}

/** Haul's own player: your files, straight from TorBox, or another service's files played through here. */
export function registerPlay(router: Router, deps: Deps): HlsJobs {
  const { library, debrid, media, progress } = deps;
  const hls = new HlsJobs(media);
  const sessions = new Map<string, LocalSession | TorboxSession>();
  const remember = (session: LocalSession | TorboxSession) => {
    for (const [id, entry] of sessions) if (Date.now() - entry.at > 12 * HOUR) sessions.delete(id);
    const id = crypto.randomBytes(12).toString('base64url');
    sessions.set(id, session);
    return id;
  };
  const sessionOf = <K extends 'local' | 'torbox'>(id: string, kind: K) => {
    const session = sessions.get(id);
    if (!session || session.kind !== kind) throw new HttpError(404, 'This playback has ended. Press play again.');
    session.at = Date.now();
    return session as Extract<LocalSession | TorboxSession, { kind: K }>;
  };

  const localFile = (type: MediaType, imdbId: string, season?: number, episode?: number): LibraryFile | undefined => {
    const files = library.byImdb(type, imdbId).flatMap((item) => item.files)
      .filter((file) => type === 'movie' || (file.season === season && file.episode !== undefined && file.episode <= episode! && (file.episodeEnd ?? file.episode) >= episode!));
    return files.sort((a, b) => b.size - a.size)[0];
  };

  // --- Service lookups, cached so pressing play costs as few round trips as possible ---
  const torrentLists = new Map<string, { at: number; value: Promise<DebridTorrent[]> }>();
  /** The service's list, at most a minute old unless `fresh`. */
  const torrents = (fresh = false): Promise<DebridTorrent[]> => {
    const service = debrid.active;
    const known = torrentLists.get(service.id);
    if (!fresh && known && Date.now() - known.at < 60_000) return known.value;
    const value = service.list();
    torrentLists.set(service.id, { at: Date.now(), value });
    value.catch(() => { if (torrentLists.get(service.id)?.value === value) torrentLists.delete(service.id); });
    return value;
  };
  const findTorrent = (list: DebridTorrent[], hash: string) => list.find((torrent) => torrent.hash?.toLowerCase() === hash || torrent.alternative_hashes?.some((value) => value.toLowerCase() === hash));
  const isReady = (torrent?: DebridTorrent) => Boolean(torrent && torrent.files?.length && (torrent.download_present || torrent.download_finished));

  /**
   * The torrent in the service's list, adding it (cached ones are ready at once) if it isn't there and
   * `add` allows. With `wait`, gives up sooner: for services that can't say what's cached, a version
   * that isn't ready in a few seconds isn't cached.
   */
  const torrentFor = async (pick: { hash: string; name: string; cached: boolean }, add = true, wait = 30_000): Promise<DebridTorrent> => {
    const service = debrid.active;
    let torrent = findTorrent(await torrents(), pick.hash);
    // The cached list may predate it, or predate it finishing.
    if (!torrent) torrent = findTorrent(await torrents(true), pick.hash);
    let id = torrent?.id;
    if (!torrent) {
      if (!add) throw new HttpError(409, `Not in the ${service.name} list`);
      if (!pick.cached && service.checksCache) throw new HttpError(409, `${service.name} doesn't have this version yet. Download it, or pick one marked Ready now.`);
      id = (await service.create(magnetFor(pick.hash, pick.name), pick.name)).torrentId;
      torrentLists.delete(service.id);
    }
    // Waiting for it to be ready: one torrent by id is several times quicker than the whole list.
    for (let waited = 0; !isReady(torrent) && waited < wait; waited += 600) {
      if (torrent && /error|failed/i.test(torrent.download_state)) throw new HttpError(502, `${service.name} reported: ${torrent.download_state}`);
      if (torrent || id !== undefined) await sleep(600);
      torrent = id !== undefined ? await service.torrent(id).catch(() => undefined) : findTorrent(await torrents(true), pick.hash);
    }
    if (!torrent || !isReady(torrent)) throw new HttpError(504, `${service.name} is still preparing this torrent. Try again in a moment.`);
    return torrent;
  };

  /**
   * For services that can't say what's cached (Real-Debrid, AllDebrid): add the best versions one at a
   * time and keep the first that's ready within a few seconds. One that isn't is removed again, so it
   * doesn't sit downloading in the account.
   */
  const firstReady = async (options: Release[]): Promise<{ pick: Release; torrent: DebridTorrent }> => {
    const service = debrid.active;
    for (const option of options.slice(0, 3)) {
      const listed = findTorrent(await torrents(), option.hash);
      let id = listed?.id;
      let added = false;
      if (id === undefined) {
        id = (await service.create(magnetFor(option.hash, option.name), option.name)).torrentId;
        added = true;
        torrentLists.delete(service.id);
      }
      if (id === undefined) continue;
      let torrent: DebridTorrent | undefined;
      for (let waited = 0; waited <= 8000; waited += 1000) {
        torrent = await service.torrent(id).catch(() => undefined);
        if (isReady(torrent) || (torrent && /error|failed/i.test(torrent.download_state))) break;
        await sleep(1000);
      }
      if (torrent && isReady(torrent)) return { pick: option, torrent };
      if (added) await service.remove(id).catch(() => undefined);
    }
    throw new HttpError(404, `${service.name} doesn't have a ready version of this yet. Download one instead; it plays from your library once it's in.`);
  };

  /** Streams TorBox made in the last hour, reused for the same file and tracks instead of asking again. */
  const streamCache = new Map<string, { at: number; value: Promise<ServiceStream> }>();
  const streamFor = (torrentId: number | string, fileId: number, audio = 0, subtitle: number | null = null, fresh = false): Promise<ServiceStream> => {
    const key = `${torrentId}:${fileId}:${audio}:${subtitle}`;
    for (const [entry, value] of streamCache) if (Date.now() - value.at > HOUR) streamCache.delete(entry);
    const hit = streamCache.get(key);
    if (hit && !fresh) return hit.value;
    const value = debrid.get('torbox').createStream!(torrentId, fileId, { audio, subtitle });
    streamCache.set(key, { at: Date.now(), value });
    value.catch(() => { if (streamCache.get(key)?.value === value) streamCache.delete(key); });
    return value;
  };

  /** TorBox playlists, kept once fetched: a finished (VOD) playlist never changes for its stream. */
  const playlists = new Map<string, { at: number; value: Promise<string> }>();
  const playlistText = (url: string): Promise<string> => {
    for (const [entry, value] of playlists) if (Date.now() - value.at > HOUR) playlists.delete(entry);
    const hit = playlists.get(url);
    if (hit) return hit.value;
    const value = (async () => {
      let response: Response | undefined;
      // A file TorBox hasn't converted before can take a moment to get its playlist.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
        if (response?.ok) break;
        // Expired or refused: retrying won't help, the caller makes a new stream.
        if (response && [401, 403, 410].includes(response.status)) break;
        await response?.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!response?.ok) throw new HttpError(502, `TorBox's stream didn't answer (${response?.status ?? 'no response'}).`);
      const text = await response.text();
      if (!/#EXT-X-(ENDLIST|PLAYLIST-TYPE:VOD)/.test(text)) playlists.delete(url);
      return text;
    })();
    playlists.set(url, { at: Date.now(), value });
    value.catch(() => { if (playlists.get(url)?.value === value) playlists.delete(url); });
    return value;
  };

  /** Asks TorBox for the start of one segment, so it converts it before the player wants it. */
  const touch = (url: string) => {
    void fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(30_000) })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  };

  /**
   * Starts TorBox working before the browser asks: the playlist, and the segment playback begins in.
   * TorBox names segments video1.ts, video2.ts… of about 5 seconds, so that one is asked for at once;
   * the playlist then confirms the real name (a wrong guess costs nothing).
   */
  const warmStream = (upstream: string, start = 0) => {
    const guess = new URL(`video${Math.floor(start / 5) + 1}.ts`, upstream);
    touch(guess.toString());
    void playlistText(upstream).then((text) => {
      let elapsed = 0;
      let pending: number | null = null;
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('#EXTINF:')) { pending = Number.parseFloat(line.slice(8)) || 0; continue; }
        if (!line || line.startsWith('#') || pending === null) continue;
        if (elapsed + pending > start) {
          const actual = new URL(line.trim(), upstream).toString();
          if (actual !== guess.toString()) touch(actual);
          return;
        }
        elapsed += pending;
        pending = null;
      }
    }).catch(() => undefined);
  };

  const pickFile = (torrent: DebridTorrent, type: MediaType, season?: number, episode?: number) => {
    const videos = torrent.files.filter((file) => VIDEO_EXTENSIONS.has(extensionOf(file.name)) && !isExtraFile(file.name, file.size));
    if (type === 'series') {
      const match = videos.filter((file) => {
        const parsed = parseEpisodeFile(file.name);
        return parsed && parsed.season === season && parsed.episode <= episode! && (parsed.episodeEnd ?? parsed.episode) >= episode!;
      }).sort((a, b) => b.size - a.size)[0];
      if (match) return match;
      // A single-episode torrent often has no SxxEyy in its file name.
      if (videos.length === 1) return videos[0];
      return undefined;
    }
    return videos.sort((a, b) => b.size - a.size)[0];
  };

  /**
   * Versions to start right away, best first: the ones the service has cached, or (for a service that
   * can't say) the best few to try.
   */
  const candidates = async (type: MediaType, imdbId: string, season?: number, episode?: number): Promise<Release[]> => {
    const service = debrid.active;
    const releases = type === 'movie' ? await deps.search.movie(imdbId) : await deps.search.episode(imdbId, season!, episode!);
    const usable = releases.filter((release) => (release.cached || !service.checksCache) && release.score > 0 && !release.info.lowQuality);
    // English releases first, dubs last; within a tier, a single file before a pack, then the usual order.
    const single = (release: Release) => (release.kind === 'movie' || release.kind === 'episode' ? 0 : 1);
    const ordered = usable.map((release, order) => ({ release, order }))
      .sort((a, b) => languageTier(a.release.info) - languageTier(b.release.info) || single(a.release) - single(b.release) || a.order - b.order)
      .map((entry) => entry.release);
    if (!ordered.length) throw new HttpError(404, service.checksCache ? `Nothing is ready on ${service.name} for this one yet. Download it, or check back later.` : 'No versions of this were found. Download it, or check back later.');
    return ordered;
  };

  /**
   * The release, torrent and file for one title, and how to play it: TorBox's own stream, or the
   * service's link played through this server. A version already in the service's list needs no
   * search at all; otherwise the best version the service has ready is found and added.
   */
  const resolveService = async (type: MediaType, imdbId: string, season?: number, episode?: number, hash?: string, add = true, wants: Wants = {}): Promise<ServiceFind> => {
    const service = debrid.active;
    let pick: { hash: string; name: string; cached: boolean };
    let torrent: DebridTorrent;
    if (hash) {
      const listed = findTorrent(await torrents(), hash);
      if (listed) pick = { hash, name: listed.name, cached: true };
      else {
        const releases = type === 'movie' ? await deps.search.movie(imdbId) : await deps.search.episode(imdbId, season!, episode!);
        const pool = [...releases, ...(type === 'series' ? await deps.search.seasonPacks(imdbId, season!, episode!, 1).catch(() => [] as Release[]) : [])];
        const found = pool.find((item) => item.hash === hash);
        if (!found) throw new HttpError(404, 'That version is no longer listed. Pick another.');
        pick = found;
      }
      torrent = await torrentFor(pick, add);
    } else {
      // A good version already in the service's list beats a better one it would have to add.
      const [list, releases, packs] = await Promise.all([
        torrents(),
        type === 'movie' ? deps.search.movie(imdbId) : deps.search.episode(imdbId, season!, episode!),
        type === 'series' ? deps.search.seasonPacks(imdbId, season!, episode!, 1).catch(() => [] as Release[]) : Promise.resolve([] as Release[])
      ]);
      const usable = (release: Release) => release.score > 0 && !release.info.lowQuality && !isForeignOnly(release.info);
      const owned = [...releases, ...packs].filter((release) => usable(release) && isReady(findTorrent(list, release.hash)))
        .sort((a, b) => languageTier(a.info) - languageTier(b.info));
      if (owned[0]) {
        pick = owned[0];
        torrent = await torrentFor(pick, add);
      } else if (service.checksCache) {
        pick = (await candidates(type, imdbId, season, episode))[0]!;
        torrent = await torrentFor(pick, add);
      } else {
        if (!add) throw new HttpError(409, `Nothing in the ${service.name} list yet`);
        ({ pick, torrent } = await firstReady(await candidates(type, imdbId, season, episode)));
      }
    }
    const target = pickFile(torrent, type, season, episode);
    if (!target) throw new HttpError(404, `This torrent has no file for S${pad(season!)}E${pad(episode!)}.`);

    if (service.createStream) {
      try {
        let stream = await streamFor(torrent.id, target.id);
        // Starts in the language you last listened in (English unless you've picked another), when the
        // release's first track is something else, and with your usual subtitles burned in.
        const audios = stream.metadata?.audios ?? [];
        const wantedAudio = wants.audio ?? 'English';
        const spoken = trackFor(audios, wantedAudio);
        let audio = 0;
        if (spoken > 0 && languageName(audios[0]?.language) !== wantedAudio) {
          const switched = await streamFor(torrent.id, target.id, spoken).catch(() => null);
          if (switched) { stream = switched; audio = spoken; }
        }
        let subtitle: number | null = null;
        const written = trackFor(stream.metadata?.subtitles ?? [], wants.subtitles);
        if (written >= 0) {
          const withSubtitles = await streamFor(torrent.id, target.id, audio, written).catch(() => null);
          if (withSubtitles) { stream = withSubtitles; subtitle = written; }
        }
        return { kind: 'torbox', name: pick.name, torrent, target, stream, audio, subtitle };
      } catch (error) {
        // Without TorBox's streaming (it's on paid plans), Haul plays the file itself if it can convert.
        const planOnly = error instanceof DebridError && /plan|pro|subscri/i.test(error.message);
        if (!planOnly || !await media.hasFfmpeg()) {
          throw new HttpError(502, planOnly ? `Streaming from ${service.name} needs a plan with streaming.` : `${service.name} couldn't start the stream: ${(error as Error).message}`);
        }
      }
    }
    const link = await service.downloadLink(torrent.id, target.id).catch((error: Error) => { throw new HttpError(502, `${service.name} didn't give a link to the file: ${error.message}`); });
    return { kind: 'remote', name: pick.name, torrent, target, link, service };
  };

  const torboxSubtitles = (stream: ServiceStream): PlaySubtitle[] => (stream.metadata?.subtitles ?? []).map((entry, position) => ({
    id: `tb:${position}`,
    label: trackLabel({ index: position, language: entry.language, title: entry.title ?? undefined }, 'subtitle'),
    language: languageName(entry.language)
  }));

  router.post('/api/play', async (ctx) => {
    const body = await ctx.body();
    const type: MediaType = body.type === 'series' ? 'series' : 'movie';
    const imdbId = String(body.imdbId ?? '');
    if (!/^tt\d+$/.test(imdbId)) throw new HttpError(400, 'Unknown title');
    const season = type === 'series' ? Number(body.season) : undefined;
    const episode = type === 'series' ? Number(body.episode) : undefined;
    if (type === 'series' && (!Number.isInteger(season) || !Number.isInteger(episode))) throw new HttpError(400, 'Which episode?');
    const caps = capsFrom(body.caps);
    const wants = wantsFrom(body);
    const hash = body.hash ? String(body.hash).toLowerCase() : undefined;
    const file = body.source === 'torbox' || hash ? undefined : localFile(type, imdbId, season, episode);
    const local = Boolean(file && fs.existsSync(file.path));
    // The title's details and the debrid side are fetched at the same time.
    const metaLoad = deps.catalog.meta(type, imdbId);
    const serviceLoad = local ? null : debrid.configured ? resolveService(type, imdbId, season, episode, hash, true, wants) : null;
    serviceLoad?.catch(() => undefined);
    const meta = await metaLoad;
    const entry = type === 'series' ? meta.episodes.find((item) => item.season === season && item.episode === episode) : undefined;
    const key = progressKey(type, imdbId, season, episode);
    const base = {
      key, type, imdbId, season, episode,
      title: meta.name,
      subtitle: type === 'series' ? `S${pad(season!)}E${pad(episode!)}${entry?.title ? ` · ${entry.title}` : ''}` : meta.year ? String(meta.year) : undefined,
      poster: meta.poster,
      background: entry?.thumbnail ?? meta.background,
      resume: progress(ctx).resumeAt(key),
      next: type === 'series' ? nextEpisode(meta, season!, episode!) : undefined
    };

    /** A file Haul plays itself: yours, or (remote) a debrid service's link to one. */
    const fileSession = async (file: LibraryFile, remote?: { service: string; name: string }): Promise<PlaySession> => {
      const canConvert = await media.hasFfmpeg();
      const probe = canConvert ? await media.probe(file.path).catch(() => null) : null;
      const spoken = probe ? trackFor(probe.audios, wants.audio) : -1;
      const audio = probe ? (spoken >= 0 ? probe.audios[spoken]!.index : defaultAudio(probe)) : 0;
      const mode = chooseMode(remote ? remote.name : file.path, probe, caps, audio, canConvert);
      const id = remember({ kind: 'local', file, probe, caps, audio, at: Date.now(), remote: Boolean(remote) });
      const sidecars = file.subtitles.map((subtitle, index) => ({ id: `s${index}`, label: `${trackLabel({ index, language: subtitle.lang }, 'subtitle')} (file)`, url: `/api/play/local/${id}/subtitle/s${index}.vtt`, language: languageName(subtitle.lang), forced: /forced/i.test(path.basename(subtitle.path)) }));
      const embedded = (probe?.subtitles ?? []).filter((subtitle) => subtitle.text).map((subtitle) => ({ id: `e${subtitle.index}`, label: trackLabel(subtitle, 'subtitle'), url: `/api/play/local/${id}/subtitle/e${subtitle.index}.vtt`, language: languageName(subtitle.language), forced: subtitle.forced, title: subtitle.title }));
      const choices = [...sidecars, ...embedded];
      const subtitles: PlaySubtitle[] = choices.map(({ id: choice, label, url, language }) => ({ id: choice, label, url, language }));
      const chosen = trackFor(choices, wants.subtitles);
      return {
        ...base,
        kind: remote ? 'remote' : 'local',
        service: remote?.service,
        url: mode === 'direct' ? `/api/play/local/${id}/file` : `/api/play/local/${id}/{start}/{audio}/playlist.m3u8`,
        mode: mode === 'direct' ? 'direct' : 'stream',
        converting: mode === 'transcode' || (probe ? !videoPlays(probe, caps) : false),
        duration: probe?.duration || undefined,
        audios: probe?.audios.map((track) => ({ index: track.index, label: trackLabel(track, 'audio'), language: languageName(track.language) })) ?? [],
        audio,
        subtitles,
        chosenSubtitle: chosen >= 0 ? subtitles[chosen]!.id : undefined,
        source: remote ? remote.name : path.basename(file.path),
        stream: id
      };
    };

    if (file && local) return ctx.json(200, await fileSession(file));

    if (!serviceLoad) throw new HttpError(400, `Add your ${debrid.name} API key in Settings to stream.`);
    const found = await serviceLoad;
    if (found.kind === 'remote') {
      const { target, link, service, name } = found;
      const parsed = parseEpisodeFile(target.name);
      const remoteFile: LibraryFile = {
        id: 'remote',
        path: link,
        relative: target.name,
        size: target.size,
        mtime: 0,
        addedAt: 0,
        season: parsed?.season,
        episode: parsed?.episode,
        resolution: parseRelease(target.name).resolution,
        tags: [],
        subtitles: []
      };
      return ctx.json(200, await fileSession(remoteFile, { service: service.name, name: name || path.basename(target.name) }));
    }
    const { name, torrent, target, stream, audio, subtitle } = found;
    warmStream(stream.hls_url, base.resume ?? 0);
    const id = remember({ kind: 'torbox', torrentId: torrent.id, fileId: target.id, upstream: stream.hls_url, audio, subtitle, at: Date.now() });
    const intro = stream.intro_information;
    const session: PlaySession = {
      ...base,
      kind: 'torbox',
      url: `/api/play/torbox/${id}/playlist.m3u8`,
      mode: 'hls',
      duration: clockSeconds(stream.metadata?.video?.duration),
      audios: (stream.metadata?.audios ?? []).map((track, position) => ({ index: position, label: trackLabel({ index: position, language: track.language, title: track.title ?? undefined, channels: track.channels }, 'audio'), language: languageName(track.language) })),
      audio,
      subtitles: torboxSubtitles(stream),
      chosenSubtitle: subtitle === null ? undefined : `tb:${subtitle}`,
      intro: intro && Number(intro.end_time) > 10 ? { start: Number(intro.start_time) || 0, end: Number(intro.end_time) } : undefined,
      source: name,
      stream: id
    };
    ctx.json(200, session);
  });

  /**
   * Warms up what pressing play needs: the search and the service's list when a title opens, and the stream
   * itself (only for versions already in that list, so nothing is added) when the pointer is on Play.
   */
  const prepared = new Map<string, number>();
  router.post('/api/play/prepare', async (ctx) => {
    const body = await ctx.body();
    const type: MediaType = body.type === 'series' ? 'series' : 'movie';
    const imdbId = String(body.imdbId ?? '');
    const season = type === 'series' ? Number(body.season) : undefined;
    const episode = type === 'series' ? Number(body.episode) : undefined;
    if (!/^tt\d+$/.test(imdbId) || (type === 'series' && (!Number.isInteger(season) || !Number.isInteger(episode)))) throw new HttpError(400, 'Unknown title');
    const key = `${progressKey(type, imdbId, season, episode)}:${body.stream ? 'stream' : 'search'}`;
    for (const [entry, at] of prepared) if (Date.now() - at > 10 * 60_000) prepared.delete(entry);
    if (Date.now() - (prepared.get(key) ?? 0) > 60_000 && debrid.configured && !localFile(type, imdbId, season, episode)) {
      prepared.set(key, Date.now());
      // resolveService warms the list and the search on its way; it stops short of adding a torrent.
      const work = body.stream
        ? resolveService(type, imdbId, season, episode, undefined, false, wantsFrom(body)).then((found) => { if (found.kind === 'torbox') warmStream(found.stream.hls_url, progress(ctx).resumeAt(progressKey(type, imdbId, season, episode)) ?? 0); })
        : Promise.all([torrents(), deps.catalog.meta(type, imdbId), candidates(type, imdbId, season, episode)]);
      work.catch(() => undefined);
    }
    ctx.json(200, { ok: true });
  });

  // --- Your files ---------------------------------------------------------------
  router.get('/api/play/local/:id/file', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'local');
    if (session.remote) return proxyRemote(ctx, session.file.path);
    sendFile(ctx, session.file.path);
  });

  router.get('/api/play/local/:id/:start/:audio/:name', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'local');
    const start = Math.max(0, Math.floor(Number(ctx.params.start) || 0));
    const audio = Math.max(0, Math.floor(Number(ctx.params.audio) || 0));
    const name = ctx.params.name!;
    const jobId = `${ctx.params.id}-${audio}`;
    if (name === 'playlist.m3u8') {
      const mode = session.probe && !videoPlays(session.probe, session.caps) ? 'transcode' : 'remux';
      await hls.open(jobId, start, session.file.path, { audio, mode, probe: session.probe, caps: session.caps }).catch((error: Error) => {
        throw new HttpError(500, `Couldn't prepare the video: ${error.message}`);
      });
      const text = hls.playlist(jobId, start);
      if (text === null) throw new HttpError(404, 'Not ready');
      ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      return ctx.res.end(text);
    }
    const file = hls.file(jobId, start, name);
    if (!file) throw new HttpError(404, 'Not ready');
    sendFile(ctx, file, { 'Cache-Control': 'private, max-age=3600' });
  });

  router.get('/api/play/local/:id/subtitle/:track.vtt', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'local');
    const track = ctx.params.track ?? '';
    let vtt: string;
    if (track.startsWith('s')) {
      const subtitle = session.file.subtitles[Number(track.slice(1))];
      if (!subtitle) throw new HttpError(404, 'Subtitle not found');
      vtt = srtToVtt(fs.readFileSync(subtitle.path, 'utf8'));
    } else if (track.startsWith('e') && await media.hasFfmpeg()) {
      vtt = await media.extractSubtitle(session.file.path, Number(track.slice(1))).catch((error: Error) => { throw new HttpError(500, error.message); });
    } else {
      throw new HttpError(404, 'Subtitle not found');
    }
    ctx.res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
    ctx.res.end(vtt);
  });

  // --- From TorBox ----------------------------------------------------------------
  const sendPlaylist = async (ctx: Context, id: string, url: string) => {
    const text = rewritePlaylist(await playlistText(url), url, deps.apiKey(), (absolute) => `/api/play/torbox/${id}/variant.m3u8?u=${encodeURIComponent(absolute)}`);
    ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    ctx.res.end(text);
  };

  router.get('/api/play/torbox/:id/playlist.m3u8', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'torbox');
    try {
      await sendPlaylist(ctx, ctx.params.id!, session.upstream);
    } catch (error) {
      // A reused stream may have expired on TorBox's side: make a new one and try once more.
      playlists.delete(session.upstream);
      const stream = await streamFor(session.torrentId, session.fileId, session.audio, session.subtitle, true).catch(() => null);
      if (!stream) throw error;
      session.upstream = stream.hls_url;
      await sendPlaylist(ctx, ctx.params.id!, session.upstream);
    }
  });

  router.get('/api/play/torbox/:id/variant.m3u8', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'torbox');
    const upstream = new URL(session.upstream);
    let target: URL;
    try { target = new URL(ctx.query.get('u') ?? ''); } catch { throw new HttpError(400, 'Bad playlist'); }
    // Only TorBox's own host, and only this stream's folder.
    const folder = upstream.pathname.slice(0, upstream.pathname.lastIndexOf('/') + 1);
    if (target.origin !== upstream.origin || !target.pathname.startsWith(folder.split('/').slice(0, 3).join('/'))) throw new HttpError(400, 'Bad playlist');
    for (const [name, value] of upstream.searchParams) if (!target.searchParams.has(name)) target.searchParams.set(name, value);
    await sendPlaylist(ctx, ctx.params.id!, target.toString());
  });

  router.post('/api/play/torbox/:id/tracks', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'torbox');
    const body = await ctx.body();
    const audio = Number.isInteger(body.audio) ? Number(body.audio) : session.audio;
    const subtitle = body.subtitle === null ? null : Number.isInteger(body.subtitle) ? Number(body.subtitle) : session.subtitle;
    const stream = await streamFor(session.torrentId, session.fileId, audio, subtitle).catch((error: Error) => {
      throw new HttpError(502, `TorBox couldn't switch tracks: ${error.message}`);
    });
    Object.assign(session, { upstream: stream.hls_url, audio, subtitle });
    ctx.json(200, { url: `/api/play/torbox/${ctx.params.id}/playlist.m3u8?v=${Date.now()}`, audio, subtitle });
  });

  router.get('/api/play/info', async (ctx) => ctx.json(200, { ffmpeg: await media.hasFfmpeg(), torbox: debrid.configured, service: debrid.name, convertsItself: Boolean(debrid.createStream) }));

  // --- Progress ---------------------------------------------------------------------
  router.post('/api/progress', async (ctx) => {
    const body = await ctx.body();
    const type: MediaType = body.type === 'series' ? 'series' : 'movie';
    const imdbId = String(body.imdbId ?? '');
    const position = Number(body.position);
    const duration = Number(body.duration);
    if (!/^tt\d+$/.test(imdbId) || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) throw new HttpError(400, 'Bad progress');
    const season = type === 'series' ? Number(body.season) : undefined;
    const episode = type === 'series' ? Number(body.episode) : undefined;
    if (type === 'series' && (!Number.isInteger(season) || !Number.isInteger(episode))) throw new HttpError(400, 'Bad progress');
    const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : undefined);
    const saved = progress(ctx).save({
      key: progressKey(type, imdbId, season, episode), type, imdbId, season, episode,
      title: text(body.title) ?? imdbId, episodeTitle: text(body.episodeTitle),
      poster: text(body.poster, 500), background: text(body.background, 500),
      position: Math.max(0, Math.min(position, duration)), duration
    });
    ctx.json(200, saved);
  });

  /** Marks episodes (or a film) watched or not without playing them, e.g. a season you saw elsewhere. */
  router.post('/api/progress/watched', async (ctx) => {
    const body = await ctx.body();
    const type: MediaType = body.type === 'series' ? 'series' : 'movie';
    const imdbId = String(body.imdbId ?? '');
    if (!/^tt\d+$/.test(imdbId)) throw new HttpError(400, 'Unknown title');
    const text = (value: unknown, max = 200) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
    const targets: Array<{ season?: number; episode?: number; title?: string }> = type === 'series'
      ? (Array.isArray(body.episodes) ? body.episodes : [])
        .filter((entry: { season?: unknown; episode?: unknown }) => Number.isInteger(entry?.season) && Number.isInteger(entry?.episode))
        .map((entry: { season: number; episode: number; title?: unknown }) => ({ season: entry.season, episode: entry.episode, title: text(entry.title) }))
        .slice(0, 1000)
      : [{}];
    if (!targets.length) throw new HttpError(400, 'Which episodes?');
    // In episode order, so the last one marked is where you are and Continue watching offers the next.
    targets.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    for (const target of targets) {
      const key = progressKey(type, imdbId, target.season, target.episode);
      if (body.watched === false) { progress(ctx).remove(key); continue; }
      const duration = progress(ctx).get(key)?.duration || 1;
      progress(ctx).save({
        key, type, imdbId, season: target.season, episode: target.episode,
        title: text(body.title) ?? imdbId, episodeTitle: target.title, poster: text(body.poster, 500), background: text(body.background, 500),
        position: duration, duration
      });
    }
    ctx.json(200, { items: progress(ctx).forTitle(type, imdbId) });
  });

  router.get('/api/progress/history', (ctx) => ctx.json(200, { items: progress(ctx).history() }));

  router.get('/api/progress/title/:type/:id', (ctx) => ctx.json(200, { items: progress(ctx).forTitle(ctx.params.type === 'series' ? 'series' : 'movie', ctx.params.id!) }));

  router.delete('/api/progress/:key', (ctx) => { progress(ctx).remove(ctx.params.key!); ctx.json(200, { ok: true }); });

  /** Unfinished titles, and for shows you finished an episode of, the next one. */
  router.get('/api/continue', async (ctx) => {
    // Shows' episode lists are looked up together, not one after another.
    const found = await Promise.all(progress(ctx).recent().map(async (entry): Promise<WatchProgress | null> => {
      if (!isFinished(entry)) return entry;
      if (entry.type !== 'series') return null;
      try {
        const meta = await deps.catalog.meta('series', entry.imdbId);
        const next = nextEpisode(meta, entry.season!, entry.episode!);
        if (!next) return null;
        const saved = progress(ctx).get(progressKey('series', entry.imdbId, next.season, next.episode));
        return saved && !isFinished(saved) ? saved : {
          ...entry,
          key: progressKey('series', entry.imdbId, next.season, next.episode),
          season: next.season, episode: next.episode, episodeTitle: next.title,
          background: meta.episodes.find((item) => item.season === next.season && item.episode === next.episode)?.thumbnail ?? entry.background,
          position: 0, upNext: true
        };
      } catch { return null; /* catalog unavailable; skip it this time */ }
    }));
    ctx.json(200, { items: found.filter((item): item is WatchProgress => item !== null).slice(0, 20) });
  });

  return hls;
}
