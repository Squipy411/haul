import type { PackFile, Release, ReleaseKind, SeasonPlan, SeasonPlanItem, Settings } from '../shared/types.js';
import { VIDEO_EXTENSIONS, extensionOf, isExtraFile, isForeignOnly, parseEpisodeFile, parseRelease, resolutionRank } from './release.js';
import { type RawResult, TORRENTSDB_URL, pirateBaySource, stremioSource, torboxSearch, torznabSource } from './sources.js';
import type { CachedTorrent, Debrid } from './debrid.js';

type Quality = Settings['quality'];

interface SearchDeps {
  /** The service in use: cache status comes from it. */
  debrid: Debrid;
  settings: () => Settings & { torboxApiKey: string };
}

const SOURCE_SCORE: Record<string, number> = { REMUX: 6, BluRay: 8, 'WEB-DL': 10, WEBRip: 5, HDTV: 0, DVD: -8, CAM: -120 };
const GB = 1024 ** 3;

function videoEpisodes(files: PackFile[]): Map<number, Set<number>> {
  const bySeason = new Map<number, Set<number>>();
  for (const file of files) {
    if (!VIDEO_EXTENSIONS.has(extensionOf(file.name)) || isExtraFile(file.name, file.size)) continue;
    const parsed = parseEpisodeFile(file.name);
    if (!parsed) continue;
    const set = bySeason.get(parsed.season) ?? new Set<number>();
    for (let episode = parsed.episode; episode <= (parsed.episodeEnd ?? parsed.episode); episode += 1) set.add(episode);
    bySeason.set(parsed.season, set);
  }
  return bySeason;
}

function videoTotal(files: PackFile[], season?: number): number {
  return files
    .filter((file) => VIDEO_EXTENSIONS.has(extensionOf(file.name)) && !isExtraFile(file.name, file.size))
    .filter((file) => season === undefined || parseEpisodeFile(file.name)?.season === season)
    .reduce((sum, file) => sum + file.size, 0);
}

export function classify(raw: RawResult, season: number | undefined, cached?: CachedTorrent): Pick<Release, 'kind' | 'packEpisodes' | 'packSeasons'> {
  if (season === undefined) return { kind: 'movie' };
  const info = parseRelease(raw.name);
  if (cached?.files.length) {
    const bySeason = videoEpisodes(cached.files);
    const seasons = [...bySeason.keys()].filter((value) => value > 0).sort((a, b) => a - b);
    const episodes = [...(bySeason.get(season) ?? [])].sort((a, b) => a - b);
    if (seasons.length > 1) return { kind: 'multi-season', packSeasons: seasons, packEpisodes: episodes };
    if (episodes.length > 1) return { kind: 'season', packSeasons: seasons, packEpisodes: episodes };
    if (episodes.length === 1) return { kind: 'episode', packSeasons: seasons, packEpisodes: episodes };
  }
  let kind: ReleaseKind;
  if (info.seasons.length > 1 || (info.complete && !info.episodes.length)) kind = 'multi-season';
  else if (info.episodes.length === 1) kind = raw.multiFile && !info.seasons.length ? 'season' : 'episode';
  else if (info.episodes.length > 1) kind = 'season';
  else if (info.seasons.length === 1) kind = 'season';
  else kind = raw.multiFile ? 'season' : 'episode';
  return {
    kind,
    packSeasons: info.seasons.length ? info.seasons : undefined,
    packEpisodes: kind === 'season' && info.episodes.length > 1 ? info.episodes : undefined
  };
}

export function scoreRelease(release: Omit<Release, 'score'>, quality: Quality, episodeCount = 1): number {
  const { info } = release;
  let score = 0;
  const rank = resolutionRank(info.resolution);
  if (quality.preferred === 'any') score += rank * 12;
  else {
    const diff = rank - resolutionRank(quality.preferred);
    score += diff === 0 ? 48 : diff < 0 ? 48 + diff * 28 : 48 - diff * 14;
  }
  if (info.resolution === 'unknown') score -= 12;
  score += release.cached ? (quality.preferCached ? 70 : 12) : 0;
  score += Math.min(18, Math.log2((release.seeders ?? 0) + 1) * 3);
  score += SOURCE_SCORE[info.source ?? ''] ?? 0;
  if (info.hdr.length && !quality.allowHdr) score -= 40;
  if (info.upscaled && !quality.allowUpscaled) score -= 60;
  if (info.threeD) score -= 70;
  if (info.lowQuality) score -= 120;
  // An uncached complete-series pack makes TorBox fetch every season first.
  if (release.kind === 'multi-season' && !release.cached) score -= 12;
  if (release.kind === 'season') score += 2;
  const foreignOnly = isForeignOnly(info);
  if (foreignOnly) score -= 30;
  const perItem = release.kind === 'movie' || release.kind === 'episode'
    ? release.fileSize ?? release.totalSize
    : release.fileSize ?? (release.totalSize ? release.totalSize / Math.max(1, episodeCount) : undefined);
  const limit = release.kind === 'movie' ? quality.maxMovieGB : quality.maxEpisodeGB;
  if (limit > 0 && perItem && perItem > limit * GB) score -= 90;
  // Bigger files carry more picture: among otherwise equal versions, the larger one wins.
  if (quality.preferLarger && perItem) score += Math.min(30, Math.log2(perItem / GB * 4 + 1) * 6);
  return Math.round(score);
}

/** Uploads that say they're a different film with the same name ("NOT The Chris Nolan FILM"). */
const DISOWNED = /\bnot[ ._-]+the\b.{0,40}?\b(film|movie)\b/i;

function blocked(name: string, words: string[]): boolean {
  if (DISOWNED.test(name)) return true;
  const lower = name.toLowerCase();
  return words.some((word) => word && lower.includes(word.toLowerCase()));
}

export class SearchService {
  private cache = new Map<string, { expires: number; value: Promise<Release[]> }>();

  constructor(private readonly deps: SearchDeps) {}

  private cached(key: string, load: () => Promise<Release[]>, fresh = false): Promise<Release[]> {
    const hit = this.cache.get(key);
    if (!fresh && hit && hit.expires > Date.now()) return hit.value;
    const value = load();
    this.cache.set(key, { expires: Date.now() + 8 * 60_000, value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async gather(type: 'movie' | 'series', stremioId: string, imdbId: string, season?: number, episode?: number): Promise<RawResult[]> {
    const settings = this.deps.settings();
    const jobs: Array<Promise<RawResult[]>> = [];
    if (settings.sources.torrentio) jobs.push(stremioSource(settings.sources.torrentioUrl, type, stremioId, 'Torrentio'));
    for (const addon of settings.sources.addons) {
      let origin = 'Addon';
      try { origin = new URL(addon).hostname.replace(/^www\./, ''); } catch { /* keep generic name */ }
      jobs.push(stremioSource(addon, type, stremioId, origin));
    }
    if (settings.sources.torboxSearch) jobs.push(torboxSearch(settings.torboxApiKey, imdbId, season, episode));
    if (settings.sources.torrentsdb) jobs.push(stremioSource(TORRENTSDB_URL, type, stremioId, 'TorrentsDB'));
    if (settings.sources.piratebay) jobs.push(pirateBaySource(imdbId));
    for (const feed of settings.sources.torznab) jobs.push(torznabSource(feed, type, imdbId, season, episode));
    const settled = await Promise.allSettled(jobs);
    const merged = new Map<string, RawResult>();
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      for (const result of outcome.value) {
        const existing = merged.get(result.hash);
        if (!existing) { merged.set(result.hash, result); continue; }
        existing.seeders = Math.max(existing.seeders ?? 0, result.seeders ?? 0) || undefined;
        existing.fileSize ??= result.fileSize;
        existing.totalSize ??= result.totalSize;
        existing.multiFile ||= result.multiFile;
        existing.fileName ??= result.fileName;
      }
    }
    if (!merged.size && settled.every((outcome) => outcome.status === 'rejected')) {
      throw new Error('No torrent source answered. Check Settings → Sources.');
    }
    return [...merged.values()];
  }

  private async build(raws: RawResult[], season: number | undefined, episodeCount: number): Promise<Release[]> {
    const settings = this.deps.settings();
    const filtered = raws.filter((raw) => !blocked(raw.name, settings.quality.blockedWords));
    let cache = new Map<string, CachedTorrent>();
    if (this.deps.debrid.configured && this.deps.debrid.checksCache && filtered.length) {
      try { cache = await this.deps.debrid.checkCached(filtered.map((raw) => raw.hash)); } catch { /* cache status is a bonus */ }
    }
    return filtered.map((raw) => {
      const cachedTorrent = cache.get(raw.hash);
      const shape = classify(raw, season, cachedTorrent);
      const release: Omit<Release, 'score'> = {
        hash: raw.hash,
        name: raw.name,
        fileName: raw.fileName,
        fileSize: raw.fileSize,
        totalSize: cachedTorrent
          ? (season !== undefined && (shape.kind === 'season' || shape.kind === 'multi-season') ? videoTotal(cachedTorrent.files, season) : 0) || videoTotal(cachedTorrent.files) || cachedTorrent.size
          : raw.totalSize,
        packSize: cachedTorrent ? videoTotal(cachedTorrent.files) || cachedTorrent.size : undefined,
        seeders: raw.seeders,
        provider: raw.provider,
        origin: raw.origin,
        info: parseRelease(raw.fileName && shape.kind !== 'season' && shape.kind !== 'multi-season' ? `${raw.name} ${raw.fileName}` : raw.name),
        cached: Boolean(cachedTorrent),
        ...shape
      };
      const count = shape.packEpisodes?.length || episodeCount;
      return { ...release, score: scoreRelease(release, settings.quality, count) };
    }).sort((a, b) => b.score - a.score || (b.seeders ?? 0) - (a.seeders ?? 0));
  }

  movie(imdbId: string, options: { fresh?: boolean } = {}): Promise<Release[]> {
    return this.cached(`movie:${imdbId}`, async () => this.build(await this.gather('movie', imdbId, imdbId), undefined, 1), options.fresh);
  }

  /** All releases that contain one episode: single-episode torrents and packs. */
  episode(imdbId: string, season: number, episode: number, options: { fresh?: boolean } = {}): Promise<Release[]> {
    return this.cached(`ep:${imdbId}:${season}:${episode}`, async () => {
      const releases = await this.build(await this.gather('series', `${imdbId}:${season}:${episode}`, imdbId, season, episode), season, 1);
      return releases.filter((release) => {
        if (release.packEpisodes?.length) return release.packEpisodes.includes(episode);
        if (release.kind === 'episode') {
          const info = release.info;
          return (!info.episodes.length || info.episodes.includes(episode)) && (!info.seasons.length || info.seasons.includes(season));
        }
        return !release.packSeasons?.length || release.packSeasons.includes(season);
      });
    }, options.fresh);
  }

  /** Season packs for one season, found through the season's first episode. */
  seasonPacks(imdbId: string, season: number, firstEpisode: number, episodeCount: number): Promise<Release[]> {
    return this.cached(`season:${imdbId}:${season}:${firstEpisode}`, async () => {
      const releases = await this.build(await this.gather('series', `${imdbId}:${season}:${firstEpisode}`, imdbId, season), season, episodeCount);
      return releases.filter((release) => {
        if (release.kind !== 'season' && release.kind !== 'multi-season') return false;
        if (release.packEpisodes) return release.packEpisodes.length > 0;
        return !release.packSeasons?.length || release.packSeasons.includes(season);
      });
    });
  }

  async planSeason(imdbId: string, season: number, wanted: number[]): Promise<SeasonPlan> {
    const plan: SeasonPlan = { imdbId, season, items: [], missing: [], skipped: [], totalSize: 0, cachedCount: 0 };
    if (!wanted.length) return plan;
    let failures = 0;
    const packs = await this.seasonPacks(imdbId, season, wanted[0]!, wanted.length).catch(() => { failures += 1; return [] as Release[]; });
    const coversAll = (release: Release) => release.packEpisodes?.length
      ? wanted.every((episode) => release.packEpisodes!.includes(episode))
      : release.kind === 'season' && !release.info.episodes.length;
    const bestPack = packs.filter((release) => release.score > -40 && coversAll(release)).sort((a, b) => b.score - a.score)[0];

    const usePack = (release: Release) => {
      plan.items = [{ episodes: [...wanted], release }];
      const packCount = release.packEpisodes?.length;
      plan.totalSize = release.totalSize && packCount
        ? Math.round((release.totalSize / packCount) * wanted.length)
        : release.fileSize ? release.fileSize * wanted.length : release.totalSize ?? 0;
      plan.cachedCount = release.cached ? wanted.length : 0;
      return plan;
    };
    if (bestPack?.cached) return usePack(bestPack);

    // Pick the best release per episode, a few episodes at a time.
    const picks = new Map<number, Release>();
    const queue = [...wanted];
    const worker = async () => {
      for (let episode = queue.shift(); episode !== undefined; episode = queue.shift()) {
        const releases = await this.episode(imdbId, season, episode).catch(() => { failures += 1; return [] as Release[]; });
        const best = releases.filter((release) => release.score > -40)[0];
        if (best) picks.set(episode, best);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // Every search failing means the sources are down or limiting us, not that nothing exists.
    if (failures === wanted.length + 1) throw new Error('The torrent sources didn\'t answer. Try again in a minute.');
    const allCached = wanted.every((episode) => picks.get(episode)?.cached);
    if (!allCached && bestPack) return usePack(bestPack);

    const grouped = new Map<string, SeasonPlanItem>();
    for (const episode of wanted) {
      const release = picks.get(episode);
      if (!release) { plan.missing.push(episode); continue; }
      const item = grouped.get(release.hash) ?? { episodes: [], release };
      item.episodes.push(episode);
      grouped.set(release.hash, item);
    }
    plan.items = [...grouped.values()];
    for (const item of plan.items) {
      const perEpisode = item.release.fileSize ?? (item.release.totalSize && item.release.kind === 'episode' ? item.release.totalSize : undefined);
      plan.totalSize += perEpisode ? perEpisode * item.episodes.length : 0;
      if (item.release.cached) plan.cachedCount += item.episodes.length;
    }
    return plan;
  }
}
