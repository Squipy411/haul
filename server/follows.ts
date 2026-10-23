import crypto from 'node:crypto';
import path from 'node:path';
import type { Follow, FollowHit, Job, LibraryFile, Meta, Release, ReleaseInfo, ScheduleItem, VersionFilter } from '../shared/types.js';
import * as catalog from './catalog.js';
import type { ServerOptions } from './config.js';
import type { JobManager } from './jobs.js';
import type { Library } from './library.js';
import type { Notifier } from './notify.js';
import { parseTitleYear, resolutionRank } from './release.js';
import type { SearchService } from './search.js';
import type { SettingsService } from './settings.js';
import { JsonFile } from './store.js';

interface Deps {
  options: ServerOptions;
  settings: SettingsService;
  catalog: typeof catalog;
  search: SearchService;
  jobs: JobManager;
  library: Library;
  notifier: Notifier;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long Haul waits for the preferred resolution once a lower one is out. */
const WAIT_FOR_BETTER = 12 * HOUR;
const pad = (value: number) => String(value).padStart(2, '0');
const RES: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD', unknown: 'unknown quality' };
const RESOLUTIONS = new Set(['2160p', '1080p', '720p']);
/** Not the film or episode itself. */
const EXTRAS = /\b(trailer|teaser|prologue|featurettes?|making[ ._-]of|behind[ ._-]the[ ._-]scenes|sample)\b/i;
const SOURCES = new Set(['WEB-DL', 'WEBRip', 'BluRay', 'REMUX']);
const HDRS = new Set(['DV', 'HDR', 'SDR']);

/** Keeps only known values, so a stored filter is always one the UI can show. */
export function cleanFilter(value: unknown): VersionFilter | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const pick = <T extends string>(list: unknown, allowed: Set<string>) => [...new Set(Array.isArray(list) ? list.filter((item): item is T => typeof item === 'string' && allowed.has(item)) : [])];
  const filter: VersionFilter = { resolutions: pick(raw.resolutions, RESOLUTIONS), sources: pick(raw.sources, SOURCES), hdr: pick(raw.hdr, HDRS) };
  return isStrict(filter) ? filter : undefined;
}

export const isStrict = (filter?: VersionFilter): filter is VersionFilter => Boolean(filter && (filter.resolutions.length || filter.sources.length || filter.hdr.length));

function matchesHdr(tags: string[], wanted: VersionFilter['hdr']): boolean {
  if (!wanted.length) return true;
  const dv = tags.includes('DV');
  const hdr = tags.some((tag) => tag === 'HDR' || tag === 'HDR10' || tag === 'HDR10+');
  return wanted.some((kind) => (kind === 'DV' ? dv : kind === 'HDR' ? hdr : !dv && !hdr));
}

/** Whether a release is one of the versions a follow asks for. */
export function matchesFilter(info: ReleaseInfo, filter: VersionFilter): boolean {
  return (!filter.resolutions.length || filter.resolutions.includes(info.resolution))
    && (!filter.sources.length || (info.source !== undefined && filter.sources.includes(info.source)))
    && matchesHdr(info.hdr, filter.hdr);
}

function fileMatches(file: LibraryFile, filter: VersionFilter): boolean {
  return (!filter.resolutions.length || (file.resolution !== undefined && filter.resolutions.includes(file.resolution)))
    && (!filter.sources.length || filter.sources.some((source) => file.tags.includes(source)))
    && matchesHdr(file.tags, filter.hdr);
}

/** "4K WEB-DL Dolby Vision", for notifications and labels. */
export function describeFilter(filter?: VersionFilter): string {
  if (!isStrict(filter)) return 'any version';
  const hdr = filter.hdr.map((kind) => (kind === 'DV' ? 'Dolby Vision' : kind === 'HDR' ? 'HDR' : 'SDR'));
  return [filter.resolutions.map((value) => RES[value]).join('/'), filter.sources.join('/'), hdr.join('/')].filter(Boolean).join(' ');
}

const describeRelease = (info: ReleaseInfo) => [RES[info.resolution], info.source, info.hdr.includes('DV') ? 'Dolby Vision' : info.hdr.length ? 'HDR' : ''].filter(Boolean).join(' ');

/** How often to look for a torrent, by how long ago the episode or movie came out. */
export function checkInterval(age: number): number | null {
  if (age < -HOUR) return null;
  if (age < DAY) return 5 * MINUTE;
  if (age < 7 * DAY) return 30 * MINUTE;
  if (age < 60 * DAY) return 6 * HOUR;
  return null;
}

/** Whether a follow looks out for this episode. Episodes from before the follow are the back catalogue. */
function watches(follow: Follow, season: number, episode: number): boolean {
  return !follow.since || season > follow.since.season || (season === follow.since.season && episode > follow.since.episode);
}

/**
 * Follows: Haul watches the torrent sources for new episodes of shows (and releases of movies)
 * you follow, tells your phone the moment one is out, and can download it straight away.
 */
export class FollowService {
  private readonly file: JsonFile<{ follows: Follow[] }>;
  private readonly lastCheck = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** The schedule reads every show's episode list, so it's kept for a minute. */
  private scheduleCache: { at: number; value: Promise<ScheduleItem[]> } | null = null;

  constructor(private readonly deps: Deps) {
    this.file = new JsonFile(path.join(deps.options.dataDir, 'follows.json'), () => ({ follows: [] }));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), MINUTE);
    setTimeout(() => void this.tick(), 15_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.file.flush();
  }

  get follows(): Follow[] {
    return this.file.data.follows;
  }

  find(type: string, imdbId: string): Follow | undefined {
    return this.follows.find((follow) => follow.type === type && follow.imdbId === imdbId);
  }

  follow(meta: Meta, autoDownload: boolean, want?: VersionFilter): Follow {
    const existing = this.find(meta.type, meta.id);
    if (existing) return this.update(existing.id, { autoDownload, want: want ?? null })!;
    // Episodes that came out more than three days ago are the backlog, not news.
    const settled = meta.episodes.filter((episode) => episode.season > 0 && episode.released && Date.parse(episode.released) < Date.now() - 3 * DAY);
    const last = settled[settled.length - 1];
    const follow: Follow = {
      id: crypto.randomUUID(),
      type: meta.type,
      imdbId: meta.id,
      title: meta.name,
      year: meta.year,
      poster: meta.poster,
      autoDownload,
      createdAt: Date.now(),
      since: meta.type === 'series' && last ? { season: last.season, episode: last.episode } : undefined,
      want: isStrict(want) ? want : undefined,
      found: {}
    };
    this.follows.unshift(follow);
    this.file.save();
    this.scheduleCache = null;
    this.lastCheck.delete(follow.id);
    void this.tick();
    return follow;
  }

  /** `want: null` clears the version filter; leaving it out keeps it. */
  update(id: string, patch: { autoDownload?: boolean; want?: VersionFilter | null }): Follow | undefined {
    const follow = this.follows.find((item) => item.id === id);
    if (!follow) return undefined;
    if (typeof patch.autoDownload === 'boolean') follow.autoDownload = patch.autoDownload;
    if (patch.want !== undefined) {
      const next = isStrict(patch.want ?? undefined) ? patch.want! : undefined;
      if (JSON.stringify(next) !== JSON.stringify(follow.want)) {
        follow.want = next;
        // What was found under the old filter no longer counts; look again straight away.
        for (const [key, hit] of Object.entries(follow.found)) if (!hit.downloadedAt) delete follow.found[key];
        for (const key of [...this.lastCheck.keys()]) if (key.startsWith(`${follow.id}:`)) this.lastCheck.delete(key);
      }
    }
    this.file.save();
    this.scheduleCache = null;
    void this.tick();
    return follow;
  }

  /** Releases worth acting on. With a version filter, only exact matches, whatever the global settings say. */
  private usable(follow: Follow, releases: Release[]): Release[] {
    const { quality } = this.deps.settings.value;
    releases = releases.filter((release) => {
      if (EXTRAS.test(release.name)) return false;
      if (follow.type !== 'movie' || !follow.year) return true;
      const year = parseTitleYear(release.name).year;
      return !year || Math.abs(year - follow.year) <= 1;
    });
    if (isStrict(follow.want)) {
      const want = follow.want;
      return releases.filter(({ info }) => matchesFilter(info, want) && !info.lowQuality && !info.threeD
        && (quality.allowUpscaled || !info.upscaled)
        && !(info.languages.length && !info.languages.some((language) => language === 'MULTI' || language === 'DUAL')));
    }
    return releases.filter((release) => release.score > 0 && !release.info.lowQuality
      && (follow.type === 'series' || resolutionRank(release.info.resolution) >= resolutionRank('720p')));
  }

  private ownsMovie(follow: Follow): boolean {
    if (!isStrict(follow.want)) return this.deps.library.ownsMovie(follow.imdbId);
    const want = follow.want;
    return this.deps.library.byImdb('movie', follow.imdbId).some((item) => item.files.some((file) => fileMatches(file, want)));
  }

  unfollow(id: string): void {
    this.file.data.follows = this.follows.filter((follow) => follow.id !== id);
    this.file.save();
    this.scheduleCache = null;
  }

  /** Follows every show in the library that isn't followed yet, without auto-download. */
  async followLibrary(): Promise<number> {
    const ids = [...new Set(this.deps.library.items.filter((item) => item.type === 'series' && item.imdbId).map((item) => item.imdbId!))]
      .filter((id) => !this.find('series', id));
    let added = 0;
    for (const id of ids) {
      try {
        this.follow(await this.deps.catalog.meta('series', id), false);
        added += 1;
      } catch { /* not in the catalog right now; try again another time */ }
    }
    return added;
  }

  /** One pass over every follow. A pass that's already running is shared rather than doubled. */
  private tick(): Promise<void> {
    if (this.running) return this.running;
    if (!this.follows.length) return Promise.resolve();
    this.running = (async () => {
      try {
        for (const follow of [...this.follows]) {
          try {
            if (follow.type === 'series') await this.checkSeries(follow);
            else await this.checkMovie(follow);
          } catch (error) {
            console.warn(`[follows] ${follow.title}: ${(error as Error).message}`);
          }
        }
        this.file.save();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private due(key: string, released: number): boolean {
    const interval = checkInterval(Date.now() - released);
    if (interval === null) return false;
    const last = this.lastCheck.get(key) ?? 0;
    if (Date.now() - last < interval) return false;
    this.lastCheck.set(key, Date.now());
    return true;
  }

  private async checkSeries(follow: Follow): Promise<void> {
    const meta = await this.deps.catalog.meta('series', follow.imdbId);
    const owned = this.deps.library.ownedEpisodes(follow.imdbId);
    const wanted = meta.episodes.filter((episode) => episode.season > 0 && episode.released && watches(follow, episode.season, episode.episode)
      && !owned.has(`${episode.season}:${episode.episode}`) && !follow.found[`${episode.season}:${episode.episode}`]?.downloadedAt);
    for (const episode of wanted.slice(0, 8)) {
      const key = `${episode.season}:${episode.episode}`;
      const hit = follow.found[key];
      if (hit && !follow.autoDownload) continue;
      if (!this.due(`${follow.id}:${key}`, Date.parse(episode.released!))) continue;
      const releases = await this.deps.search.episode(follow.imdbId, episode.season, episode.episode, { fresh: true });
      const usable = this.usable(follow, releases);
      if (!usable.length) continue;
      const code = `S${pad(episode.season)}E${pad(episode.episode)}`;
      await this.handleFound(follow, meta, key, usable, {
        label: `${follow.title} ${code}`,
        path: `/title/series/${follow.imdbId}?season=${episode.season}`,
        season: episode.season,
        episodes: [episode.episode]
      });
    }
  }

  private async checkMovie(follow: Follow): Promise<void> {
    if (follow.found.movie?.downloadedAt || this.ownsMovie(follow)) return;
    if (follow.found.movie && !follow.autoDownload) return;
    const key = `${follow.id}:movie`;
    // Cinemeta knows the cinema date, not the digital one, so once a film is out it's checked every
    // 20 minutes until a version turns up (every 5 on the day itself), and twice a day before that.
    const last = this.lastCheck.get(key) ?? 0;
    if (Date.now() - last < 5 * MINUTE) return;
    const meta = await this.deps.catalog.meta('movie', follow.imdbId);
    const released = meta.released ? Date.parse(meta.released) : follow.createdAt;
    const age = Date.now() - released;
    const interval = age < 0 ? 12 * HOUR : age < DAY ? 5 * MINUTE : 20 * MINUTE;
    if (Date.now() - last < interval) return;
    this.lastCheck.set(key, Date.now());
    const releases = await this.deps.search.movie(follow.imdbId, { fresh: true });
    const usable = this.usable(follow, releases);
    if (!usable.length) return;
    await this.handleFound(follow, meta, 'movie', usable, { label: follow.title, path: `/title/movie/${follow.imdbId}` });
  }

  private async handleFound(follow: Follow, meta: Meta, key: string, usable: Release[], target: { label: string; path: string; season?: number; episodes?: number[] }): Promise<void> {
    const preferred = this.deps.settings.value.quality.preferred;
    const strict = isStrict(follow.want);
    // A version filter is the user's exact choice, so the first match is taken; otherwise wait a while for the preferred resolution.
    const meets = (release: Release) => strict || preferred === 'any' || resolutionRank(release.info.resolution) >= resolutionRank(preferred);
    const best = usable[0]!;
    const bestPreferred = usable.find(meets);
    let hit: FollowHit | undefined = follow.found[key];
    const firstSighting = !hit;
    if (!hit) {
      hit = { foundAt: Date.now(), release: best.name, resolution: best.info.resolution, cached: best.cached };
      follow.found[key] = hit;
    }

    if (follow.autoDownload) {
      const pick = bestPreferred ?? (Date.now() - hit.foundAt >= WAIT_FOR_BETTER ? best : undefined);
      if (pick) {
        const job: Job = this.deps.jobs.create({ meta, release: pick, season: target.season, episodes: target.episodes });
        Object.assign(hit, { downloadedAt: Date.now(), jobId: job.id, release: pick.name, resolution: pick.info.resolution, cached: pick.cached, waitingForBetter: false });
        await this.deps.notifier.send({
          title: `${target.label} is downloading`,
          message: `${describeRelease(pick.info)}${pick.cached ? ', ready now on TorBox' : ', TorBox is fetching it'}. ${pick.name}`,
          path: target.path,
          priority: 4,
          tags: ['arrow_down']
        });
        hit.notifiedAt = Date.now();
        return;
      }
      if (firstSighting) {
        hit.waitingForBetter = true;
        await this.deps.notifier.send({
          title: `${target.label} is out in ${RES[best.info.resolution]}`,
          message: `Waiting up to 12 hours for ${RES[preferred]} before downloading. Open Haul to grab it now.`,
          path: target.path,
          priority: 3,
          tags: ['hourglass']
        });
        hit.notifiedAt = Date.now();
      }
      return;
    }

    if (firstSighting) {
      await this.deps.notifier.send({
        title: strict ? `${target.label} is out in ${describeFilter(follow.want)}` : `${target.label} is available`,
        message: `${describeRelease(best.info)}${best.cached ? ', ready now on TorBox' : ''}. ${usable.length} matching version${usable.length === 1 ? '' : 's'} found.`,
        path: target.path,
        priority: 4,
        tags: ['tv']
      });
      hit.notifiedAt = Date.now();
    }
  }

  /** What's coming and what just came out, for followed shows and shows in the library. */
  schedule(jobs: Job[]): Promise<ScheduleItem[]> {
    if (this.scheduleCache && Date.now() - this.scheduleCache.at < 60_000) return this.scheduleCache.value;
    const value = this.buildSchedule(jobs);
    this.scheduleCache = { at: Date.now(), value };
    value.catch(() => { this.scheduleCache = null; });
    return value;
  }

  private async buildSchedule(jobs: Job[]): Promise<ScheduleItem[]> {
    const followed = new Set(this.follows.map((follow) => `${follow.type}:${follow.imdbId}`));
    const seriesIds = [...new Set([
      ...this.follows.filter((follow) => follow.type === 'series').map((follow) => follow.imdbId),
      ...this.deps.library.items.filter((item) => item.type === 'series' && item.imdbId).map((item) => item.imdbId!)
    ])].slice(0, 80);
    const now = Date.now();
    const items: ScheduleItem[] = [];
    const queue = [...seriesIds];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const meta = await this.deps.catalog.meta('series', id);
          const owned = this.deps.library.ownedEpisodes(id);
          const follow = this.find('series', id);
          for (const episode of meta.episodes) {
            if (!episode.released || episode.season === 0) continue;
            const at = Date.parse(episode.released);
            if (at < now - 7 * DAY || at > now + 45 * DAY) continue;
            const key = `${episode.season}:${episode.episode}`;
            const hit = follow?.found[key];
            const downloading = jobs.some((job) => job.imdbId === id && job.season === episode.season && job.episodes?.includes(episode.episode) && ['queued', 'torbox', 'downloading', 'paused'].includes(job.status));
            items.push({
              imdbId: id, type: 'series', title: meta.name, poster: meta.poster, background: meta.background,
              season: episode.season, episode: episode.episode, episodeTitle: episode.title, released: episode.released,
              followed: followed.has(`series:${id}`),
              state: owned.has(key) ? 'owned' : downloading ? 'downloading' : hit ? 'available' : at > now ? 'upcoming' : follow && watches(follow, episode.season, episode.episode) ? 'searching' : 'aired',
              release: hit?.release
            });
          }
        } catch { /* catalog unavailable for this one */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const follow of this.follows.filter((item) => item.type === 'movie')) {
      try {
        const meta = await this.deps.catalog.meta('movie', follow.imdbId);
        if (!meta.released) continue;
        const hit = follow.found.movie;
        items.push({
          imdbId: follow.imdbId, type: 'movie', title: meta.name, poster: meta.poster, background: meta.background, released: meta.released,
          followed: true,
          state: this.ownsMovie(follow) ? 'owned' : hit?.downloadedAt ? 'downloading' : hit ? 'available' : Date.parse(meta.released) > now ? 'upcoming' : 'searching',
          release: hit?.release
        });
      } catch { /* skip */ }
    }
    return items.sort((a, b) => a.released.localeCompare(b.released));
  }
}
