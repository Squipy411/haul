import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryFile, MediaType, Meta, PlayCaps, PlaySession, PlaySubtitle, Release, WatchProgress } from '../shared/types.js';
import type * as catalog from './catalog.js';
import { type Context, HttpError, type Router, sendFile } from './http.js';
import type { Library } from './library.js';
import { type Caps, HlsJobs, type MediaTools, type Probe, chooseMode, defaultAudio, srtToVtt, trackLabel, videoPlays } from './media.js';
import { type ProgressStore, isFinished, progressKey } from './progress.js';
import { VIDEO_EXTENSIONS, extensionOf, isExtraFile, parseEpisodeFile } from './release.js';
import type { SearchService } from './search.js';
import { type Torbox, TorboxError, type TorboxStream, type TorboxTorrent, magnetFor } from './torbox.js';

interface Deps {
  library: Library;
  catalog: typeof catalog;
  search: SearchService;
  torbox: Torbox;
  media: MediaTools;
  progress: ProgressStore;
  apiKey: () => string;
}

const pad = (value: number) => String(value).padStart(2, '0');
const HOUR = 3_600_000;

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

interface LocalSession { kind: 'local'; file: LibraryFile; probe: Probe | null; caps: Caps; audio: number; at: number }
interface TorboxSession { kind: 'torbox'; torrentId: number; fileId: number; upstream: string; audio: number; subtitle: number | null; at: number }

/** Haul's own player: your files, or straight from TorBox. */
export function registerPlay(router: Router, deps: Deps): HlsJobs {
  const { library, torbox, media, progress } = deps;
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

  /** The torrent in the TorBox list, adding it (cached ones are ready at once) if it isn't there. */
  const torrentFor = async (release: Release): Promise<TorboxTorrent> => {
    const find = (list: TorboxTorrent[]) => list.find((torrent) => torrent.hash?.toLowerCase() === release.hash || torrent.alternative_hashes?.some((hash) => hash.toLowerCase() === release.hash));
    const ready = (torrent?: TorboxTorrent) => Boolean(torrent && torrent.files?.length && (torrent.download_present || torrent.download_finished));
    let torrent = find(await torbox.list());
    if (!torrent) {
      if (!release.cached) throw new HttpError(409, "TorBox doesn't have this version yet. Download it, or pick one marked Ready now.");
      await torbox.create(magnetFor(release.hash, release.name), release.name);
    }
    for (let waited = 0; !ready(torrent) && waited < 30_000; waited += 1500) {
      if (torrent && /error|failed/i.test(torrent.download_state)) throw new HttpError(502, `TorBox reported: ${torrent.download_state}`);
      await new Promise((resolve) => setTimeout(resolve, torrent ? 1500 : 800));
      torrent = find(await torbox.list());
    }
    if (!torrent || !ready(torrent)) throw new HttpError(504, 'TorBox is still preparing this torrent. Try again in a moment.');
    return torrent;
  };

  const pickFile = (torrent: TorboxTorrent, type: MediaType, season?: number, episode?: number) => {
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

  /** The best version TorBox can start right away. */
  const bestCached = async (type: MediaType, imdbId: string, season?: number, episode?: number): Promise<Release> => {
    const releases = type === 'movie' ? await deps.search.movie(imdbId) : await deps.search.episode(imdbId, season!, episode!);
    const ready = releases.filter((release) => release.cached && release.score > 0 && !release.info.lowQuality);
    const best = ready.find((release) => release.kind === 'movie' || release.kind === 'episode') ?? ready[0];
    if (!best) throw new HttpError(404, 'Nothing is ready on TorBox for this one yet. Download it, or check back later.');
    return best;
  };

  const torboxSubtitles = (stream: TorboxStream): PlaySubtitle[] => (stream.metadata?.subtitles ?? []).map((entry, position) => ({
    id: `tb:${position}`,
    label: trackLabel({ index: position, language: entry.language, title: entry.title ?? undefined }, 'subtitle')
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
    const meta = await deps.catalog.meta(type, imdbId);
    const entry = type === 'series' ? meta.episodes.find((item) => item.season === season && item.episode === episode) : undefined;
    const key = progressKey(type, imdbId, season, episode);
    const base = {
      key, type, imdbId, season, episode,
      title: meta.name,
      subtitle: type === 'series' ? `S${pad(season!)}E${pad(episode!)}${entry?.title ? ` · ${entry.title}` : ''}` : meta.year ? String(meta.year) : undefined,
      poster: meta.poster,
      background: entry?.thumbnail ?? meta.background,
      resume: progress.resumeAt(key),
      next: type === 'series' ? nextEpisode(meta, season!, episode!) : undefined
    };

    const file = body.source === 'torbox' || body.hash ? undefined : localFile(type, imdbId, season, episode);
    if (file && fs.existsSync(file.path)) {
      const canConvert = await media.hasFfmpeg();
      const probe = canConvert ? await media.probe(file.path).catch(() => null) : null;
      const audio = probe ? defaultAudio(probe) : 0;
      const mode = chooseMode(file.path, probe, caps, audio, canConvert);
      const id = remember({ kind: 'local', file, probe, caps, audio, at: Date.now() });
      const subtitles: PlaySubtitle[] = [
        ...file.subtitles.map((subtitle, index) => ({ id: `s${index}`, label: `${trackLabel({ index, language: subtitle.lang === 'und' ? undefined : subtitle.lang }, 'subtitle')} (file)`, url: `/api/play/local/${id}/subtitle/s${index}.vtt` })),
        ...(probe?.subtitles.filter((subtitle) => subtitle.text).map((subtitle) => ({ id: `e${subtitle.index}`, label: trackLabel(subtitle, 'subtitle'), url: `/api/play/local/${id}/subtitle/e${subtitle.index}.vtt` })) ?? [])
      ];
      const session: PlaySession = {
        ...base,
        kind: 'local',
        url: mode === 'direct' ? `/api/play/local/${id}/file` : `/api/play/local/${id}/{start}/{audio}/playlist.m3u8`,
        mode: mode === 'direct' ? 'direct' : 'stream',
        converting: mode === 'transcode' || (probe ? !videoPlays(probe, caps) : false),
        duration: probe?.duration || undefined,
        audios: probe?.audios.map((track) => ({ index: track.index, label: trackLabel(track, 'audio') })) ?? [],
        audio,
        subtitles,
        source: path.basename(file.path),
        stream: id
      };
      return ctx.json(200, session);
    }

    if (!torbox.configured) throw new HttpError(400, 'Add your TorBox API key in Settings to stream.');
    let release: Release;
    if (body.hash) {
      const releases = type === 'movie' ? await deps.search.movie(imdbId) : await deps.search.episode(imdbId, season!, episode!);
      const pool = [...releases, ...(type === 'series' ? await deps.search.seasonPacks(imdbId, season!, episode!, 1).catch(() => [] as Release[]) : [])];
      const found = pool.find((item) => item.hash === String(body.hash).toLowerCase());
      if (!found) throw new HttpError(404, 'That version is no longer listed. Pick another.');
      release = found;
    } else {
      release = await bestCached(type, imdbId, season, episode);
    }
    const torrent = await torrentFor(release);
    const target = pickFile(torrent, type, season, episode);
    if (!target) throw new HttpError(404, `This torrent has no file for S${pad(season!)}E${pad(episode!)}.`);
    const stream = await torbox.createStream(torrent.id, target.id).catch((error: Error) => {
      throw new HttpError(502, error instanceof TorboxError && /plan|pro|subscri/i.test(error.message) ? 'Streaming from TorBox needs a TorBox Pro plan.' : `TorBox couldn't start the stream: ${error.message}`);
    });
    const id = remember({ kind: 'torbox', torrentId: torrent.id, fileId: target.id, upstream: stream.hls_url, audio: 0, subtitle: null, at: Date.now() });
    const intro = stream.intro_information;
    const session: PlaySession = {
      ...base,
      kind: 'torbox',
      url: `/api/play/torbox/${id}/playlist.m3u8`,
      mode: 'hls',
      duration: clockSeconds(stream.metadata?.video?.duration),
      audios: (stream.metadata?.audios ?? []).map((track, position) => ({ index: position, label: trackLabel({ index: position, language: track.language, title: track.title ?? undefined, channels: track.channels }, 'audio') })),
      audio: 0,
      subtitles: torboxSubtitles(stream),
      intro: intro && Number(intro.end_time) > 10 ? { start: Number(intro.start_time) || 0, end: Number(intro.end_time) } : undefined,
      source: release.name,
      stream: id
    };
    ctx.json(200, session);
  });

  // --- Your files ---------------------------------------------------------------
  router.get('/api/play/local/:id/file', (ctx) => sendFile(ctx, sessionOf(ctx.params.id!, 'local').file.path));

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
    let response: Response | undefined;
    // A file TorBox hasn't converted before can take a moment to get its playlist.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
      if (response?.ok) break;
      await response?.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!response?.ok) throw new HttpError(502, `TorBox's stream didn't answer (${response?.status ?? 'no response'}).`);
    const text = rewritePlaylist(await response.text(), url, deps.apiKey(), (absolute) => `/api/play/torbox/${id}/variant.m3u8?u=${encodeURIComponent(absolute)}`);
    ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    ctx.res.end(text);
  };

  router.get('/api/play/torbox/:id/playlist.m3u8', async (ctx) => {
    const session = sessionOf(ctx.params.id!, 'torbox');
    await sendPlaylist(ctx, ctx.params.id!, session.upstream);
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
    const stream = await torbox.createStream(session.torrentId, session.fileId, { audio, subtitle }).catch((error: Error) => {
      throw new HttpError(502, `TorBox couldn't switch tracks: ${error.message}`);
    });
    Object.assign(session, { upstream: stream.hls_url, audio, subtitle });
    ctx.json(200, { url: `/api/play/torbox/${ctx.params.id}/playlist.m3u8?v=${Date.now()}`, audio, subtitle });
  });

  router.get('/api/play/info', async (ctx) => ctx.json(200, { ffmpeg: await media.hasFfmpeg(), torbox: torbox.configured }));

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
    const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : undefined);
    const saved = progress.save({
      key: progressKey(type, imdbId, season, episode), type, imdbId, season, episode,
      title: text(body.title) ?? imdbId, episodeTitle: text(body.episodeTitle),
      poster: text(body.poster, 500), background: text(body.background, 500),
      position: Math.max(0, Math.min(position, duration)), duration
    });
    ctx.json(200, saved);
  });

  router.delete('/api/progress/:key', (ctx) => { progress.remove(ctx.params.key!); ctx.json(200, { ok: true }); });

  /** Unfinished titles, and for shows you finished an episode of, the next one. */
  router.get('/api/continue', async (ctx) => {
    const items: WatchProgress[] = [];
    for (const entry of progress.recent()) {
      if (!isFinished(entry)) { items.push(entry); continue; }
      if (entry.type !== 'series') continue;
      try {
        const meta = await deps.catalog.meta('series', entry.imdbId);
        const next = nextEpisode(meta, entry.season!, entry.episode!);
        if (!next) continue;
        const saved = progress.get(progressKey('series', entry.imdbId, next.season, next.episode));
        items.push(saved && !isFinished(saved) ? saved : {
          ...entry,
          key: progressKey('series', entry.imdbId, next.season, next.episode),
          season: next.season, episode: next.episode, episodeTitle: next.title,
          background: meta.episodes.find((item) => item.season === next.season && item.episode === next.episode)?.thumbnail ?? entry.background,
          position: 0, upNext: true
        });
      } catch { /* catalog unavailable; skip it this time */ }
    }
    ctx.json(200, { items: items.slice(0, 20) });
  });

  return hls;
}
