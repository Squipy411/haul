import crypto from 'node:crypto';
import path from 'node:path';
import type { Follow, FollowHit, Job, Meta, Release, ScheduleItem } from '../shared/types.js';
import * as catalog from './catalog.js';
import type { ServerOptions } from './config.js';
import type { JobManager } from './jobs.js';
import type { Library } from './library.js';
import type { Notifier } from './notify.js';
import { resolutionRank } from './release.js';
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

  follow(meta: Meta, autoDownload: boolean): Follow {
    const existing = this.find(meta.type, meta.id);
    if (existing) {
      existing.autoDownload = autoDownload;
      this.file.save();
      return existing;
    }
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
      found: {}
    };
    this.follows.unshift(follow);
    this.file.save();
    this.lastCheck.delete(follow.id);
    void this.tick();
    return follow;
  }

  update(id: string, patch: { autoDownload?: boolean }): Follow | undefined {
    const follow = this.follows.find((item) => item.id === id);
    if (!follow) return undefined;
    if (typeof patch.autoDownload === 'boolean') follow.autoDownload = patch.autoDownload;
    this.file.save();
    if (follow.autoDownload) void this.tick();
    return follow;
  }

  unfollow(id: string): void {
    this.file.data.follows = this.follows.filter((follow) => follow.id !== id);
    this.file.save();
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
      const usable = releases.filter((release) => release.score > 0 && !release.info.lowQuality);
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
    if (follow.found.movie?.downloadedAt || this.deps.library.ownsMovie(follow.imdbId)) return;
    if (follow.found.movie && !follow.autoDownload) return;
    const meta = await this.deps.catalog.meta('movie', follow.imdbId);
    // Before its release date a film is checked twice a day; afterwards as often as a new episode.
    const released = meta.released ? Date.parse(meta.released) : follow.createdAt;
    const key = `${follow.id}:movie`;
    const interval = Date.now() < released ? 12 * HOUR : checkInterval(Date.now() - released) ?? 6 * HOUR;
    if (Date.now() - (this.lastCheck.get(key) ?? 0) < interval) return;
    this.lastCheck.set(key, Date.now());
    const releases = await this.deps.search.movie(follow.imdbId, { fresh: true });
    const usable = releases.filter((release) => release.score > 0 && !release.info.lowQuality && resolutionRank(release.info.resolution) >= resolutionRank('720p'));
    if (!usable.length) return;
    await this.handleFound(follow, meta, 'movie', usable, { label: follow.title, path: `/title/movie/${follow.imdbId}` });
  }

  private async handleFound(follow: Follow, meta: Meta, key: string, usable: Release[], target: { label: string; path: string; season?: number; episodes?: number[] }): Promise<void> {
    const preferred = this.deps.settings.value.quality.preferred;
    const meets = (release: Release) => preferred === 'any' || resolutionRank(release.info.resolution) >= resolutionRank(preferred);
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
          message: `${RES[pick.info.resolution]}${pick.cached ? ', ready now on TorBox' : ', TorBox is fetching it'}. ${pick.name}`,
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
        title: `${target.label} is available`,
        message: `${RES[best.info.resolution]}${best.cached ? ', ready now on TorBox' : ''}. ${usable.length} version${usable.length === 1 ? '' : 's'} found.`,
        path: target.path,
        priority: 4,
        tags: ['tv']
      });
      hit.notifiedAt = Date.now();
    }
  }

  /** What's coming and what just came out, for followed shows and shows in the library. */
  async schedule(jobs: Job[]): Promise<ScheduleItem[]> {
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
          state: this.deps.library.ownsMovie(follow.imdbId) ? 'owned' : hit?.downloadedAt ? 'downloading' : hit ? 'available' : Date.parse(meta.released) > now ? 'upcoming' : 'searching',
          release: hit?.release
        });
      } catch { /* skip */ }
    }
    return items.sort((a, b) => a.released.localeCompare(b.released));
  }
}
