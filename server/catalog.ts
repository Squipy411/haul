import type { Episode, HomeRow, MediaType, Meta, MetaPreview } from '../shared/types.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';

interface CacheEntry<T> { expires: number; value: Promise<T> }

class TtlCache {
  private entries = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { expires: now + ttlMs, value });
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > 2000) {
      for (const [entryKey, entry] of this.entries) if (entry.expires <= now) this.entries.delete(entryKey);
    }
    return value;
  }
}

const cache = new TtlCache();

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Haul/1.0' } });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function upgradeImage(url: string | undefined, kind: 'poster' | 'background' | 'logo'): string | undefined {
  if (!url) return undefined;
  if (url.includes('images.metahub.space')) {
    const size = kind === 'poster' ? 'medium' : 'large';
    return url.replace(/\/(poster|background|logo)\/(small|medium|large)\//, `/$1/${size}/`);
  }
  return url;
}

export function posterFor(imdbId: string): string {
  return `https://images.metahub.space/poster/medium/${imdbId}/img`;
}

export function backgroundFor(imdbId: string): string {
  return `https://images.metahub.space/background/large/${imdbId}/img`;
}

function preview(raw: any, type: MediaType): MetaPreview | null {
  const id = raw?.imdb_id || raw?.id;
  if (!id || !raw?.name) return null;
  return {
    id,
    type,
    name: raw.name,
    poster: upgradeImage(raw.poster, 'poster') || (id.startsWith('tt') ? posterFor(id) : undefined),
    background: upgradeImage(raw.background, 'background'),
    logo: upgradeImage(raw.logo, 'logo'),
    releaseInfo: raw.releaseInfo || (raw.year ? String(raw.year) : undefined),
    imdbRating: raw.imdbRating || undefined,
    description: raw.description || undefined,
    genres: raw.genres || raw.genre || undefined
  };
}

export async function catalog(type: MediaType, id: 'top' | 'year' | 'imdbRating', options: { genre?: string; skip?: number; search?: string } = {}): Promise<MetaPreview[]> {
  const extras: string[] = [];
  if (options.search) extras.push(`search=${encodeURIComponent(options.search)}`);
  if (options.genre) extras.push(`genre=${encodeURIComponent(options.genre)}`);
  if (options.skip) extras.push(`skip=${options.skip}`);
  const url = `${CINEMETA}/catalog/${type}/${id}${extras.length ? `/${extras.join('&')}` : ''}.json`;
  const ttl = options.search ? 10 * 60_000 : 60 * 60_000;
  const data = await cache.get(url, ttl, () => getJson<{ metas?: any[] }>(url));
  return (data.metas || []).map((item) => preview(item, type)).filter((item): item is MetaPreview => Boolean(item));
}

export async function home(): Promise<HomeRow[]> {
  const year = String(new Date().getFullYear());
  const rows: Array<{ id: string; title: string; type: MediaType; load: () => Promise<MetaPreview[]> }> = [
    { id: 'series-top', title: 'Popular shows', type: 'series', load: () => catalog('series', 'top') },
    { id: 'movie-top', title: 'Popular movies', type: 'movie', load: () => catalog('movie', 'top') },
    { id: 'series-new', title: `New shows`, type: 'series', load: () => catalog('series', 'year', { genre: year }) },
    { id: 'movie-new', title: `New movies`, type: 'movie', load: () => catalog('movie', 'year', { genre: year }) },
    { id: 'series-featured', title: 'Top rated shows', type: 'series', load: () => catalog('series', 'imdbRating') },
    { id: 'movie-featured', title: 'Top rated movies', type: 'movie', load: () => catalog('movie', 'imdbRating') }
  ];
  const settled = await Promise.allSettled(rows.map((row) => row.load()));
  return rows
    .map((row, index) => ({ id: row.id, title: row.title, type: row.type, items: settled[index]!.status === 'fulfilled' ? (settled[index] as PromiseFulfilledResult<MetaPreview[]>).value : [] }))
    .filter((row) => row.items.length);
}

export async function search(query: string): Promise<{ movies: MetaPreview[]; series: MetaPreview[] }> {
  const text = query.trim().slice(0, 120);
  if (!text) return { movies: [], series: [] };
  const imdb = /tt\d{5,10}/.exec(text)?.[0];
  if (imdb) {
    const [movie, series] = await Promise.allSettled([meta('movie', imdb), meta('series', imdb)]);
    return {
      movies: movie.status === 'fulfilled' ? [movie.value] : [],
      series: series.status === 'fulfilled' && series.value.episodes.length ? [series.value] : []
    };
  }
  const [movies, series] = await Promise.allSettled([catalog('movie', 'top', { search: text }), catalog('series', 'top', { search: text })]);
  return {
    movies: movies.status === 'fulfilled' ? movies.value : [],
    series: series.status === 'fulfilled' ? series.value : []
  };
}

export function firstYear(value: unknown): number | undefined {
  const match = /(19|20)\d{2}/.exec(String(value ?? ''));
  return match ? Number(match[0]) : undefined;
}

export async function meta(type: MediaType, id: string): Promise<Meta> {
  if (!/^tt\d{5,10}$/.test(id)) throw new Error('Unknown title id');
  const url = `${CINEMETA}/meta/${type}/${id}.json`;
  const data = await cache.get(url, 6 * 60 * 60_000, () => getJson<{ meta?: any }>(url));
  const raw = data.meta;
  if (!raw || !raw.name || (raw.type && raw.type !== type)) throw new Error('Title not found');
  const base = preview(raw, type)!;
  const episodes: Episode[] = type === 'series'
    ? (raw.videos || [])
      .filter((video: any) => Number.isInteger(video.season) && Number.isInteger(video.episode ?? video.number))
      .map((video: any) => ({
        id: video.id || `${id}:${video.season}:${video.episode ?? video.number}`,
        season: video.season,
        episode: video.episode ?? video.number,
        title: video.name || video.title || `Episode ${video.episode ?? video.number}`,
        overview: video.overview || video.description || undefined,
        thumbnail: video.thumbnail || undefined,
        released: video.released || video.firstAired || undefined
      }))
      .sort((a: Episode, b: Episode) => a.season - b.season || a.episode - b.episode)
    : [];
  const seasons = [...new Set(episodes.map((episode) => episode.season))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const trailer = raw.trailerStreams?.[0]?.ytId || raw.trailers?.[0]?.source;
  return {
    ...base,
    id,
    background: base.background || backgroundFor(id),
    year: firstYear(raw.year ?? raw.releaseInfo),
    runtime: raw.runtime || undefined,
    cast: raw.cast || undefined,
    director: raw.director || undefined,
    status: raw.status || undefined,
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer}` : undefined,
    released: type === 'movie' ? raw.released || undefined : undefined,
    episodes,
    seasons
  };
}

/** Raw Cinemeta meta, passed straight through to Stremio clients by the library addon. */
export async function rawMeta(type: MediaType, id: string): Promise<any | null> {
  if (!/^tt\d{5,10}$/.test(id)) return null;
  const url = `${CINEMETA}/meta/${type}/${id}.json`;
  try {
    const data = await cache.get(url, 6 * 60 * 60_000, () => getJson<{ meta?: any }>(url));
    return data.meta || null;
  } catch {
    return null;
  }
}
