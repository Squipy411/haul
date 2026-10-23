import { parseSize } from './release.js';
import { base32Decode } from './totp.js';

/** A torrent found by a source, before it is classified and scored. */
export interface RawResult {
  hash: string;
  name: string;
  fileName?: string;
  fileSize?: number;
  totalSize?: number;
  seeders?: number;
  provider?: string;
  origin: string;
  multiFile: boolean;
}

const HASH = /^[a-f0-9]{40}$/i;

async function getJson(url: string, headers: Record<string, string> = {}, timeout = 15_000): Promise<any> {
  return JSON.parse(await getText(url, headers, timeout));
}

async function getText(url: string, headers: Record<string, string> = {}, timeout = 15_000): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Haul/1.0', ...headers } });
    if (response.ok) return response.text();
    // Rate limits and hiccups usually clear in a moment; one retry saves a whole season plan.
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel();
      const wait = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(wait) && wait > 0 ? Math.min(wait, 10) * 1000 : 1500));
      continue;
    }
    throw new Error(`HTTP ${response.status}`);
  }
}

/** Parses streams from any Stremio addon that returns torrents (infoHash), e.g. Torrentio. */
export function parseStremioStreams(streams: any[], origin: string): RawResult[] {
  const results: RawResult[] = [];
  for (const stream of streams || []) {
    const hash = String(stream?.infoHash || '').toLowerCase();
    if (!HASH.test(hash)) continue;
    const text = String(stream.title || stream.description || '');
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const statsIndex = lines.findIndex((line) => /👤|💾|⚙️|🔍/.test(line));
    const nameLines = statsIndex === -1 ? lines : lines.slice(0, statsIndex);
    const stats = statsIndex === -1 ? '' : lines.slice(statsIndex).join(' ');
    const filename = stream.behaviorHints?.filename as string | undefined;
    const name = nameLines[0] || filename || stream.name || hash;
    const fileLine = nameLines.length > 1 ? nameLines[nameLines.length - 1] : undefined;
    const seeders = /👤\s*(\d+)/.exec(stats)?.[1];
    const provider = /⚙️\s*([^\s🇦-🇿]+)/u.exec(stats)?.[1] ?? /🔍\s*([^\s]+)/u.exec(stats)?.[1];
    results.push({
      hash,
      name,
      fileName: fileLine ? fileLine.split('/').pop() : filename,
      fileSize: parseSize(/💾\s*([\d.,]+\s*[KMGT]B)/i.exec(stats)?.[1] ?? '') ?? (Number(stream.behaviorHints?.videoSize) || undefined),
      seeders: seeders ? Number(seeders) : undefined,
      provider,
      origin,
      multiFile: Boolean(fileLine)
    });
  }
  return results;
}

export async function stremioSource(baseUrl: string, type: 'movie' | 'series', id: string, origin: string): Promise<RawResult[]> {
  const base = baseUrl.replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
  const data = await getJson(`${base}/stream/${type}/${encodeURIComponent(id)}.json`);
  return parseStremioStreams(data?.streams || [], origin);
}

/** TorBox's own torrent search. Optional: any failure just means no extra results. */
export async function torboxSearch(apiKey: string, imdbId: string, season?: number, episode?: number): Promise<RawResult[]> {
  if (!apiKey) return [];
  const url = new URL(`https://search-api.torbox.app/torrents/imdb:${imdbId}`);
  url.searchParams.set('metadata', 'false');
  url.searchParams.set('check_cache', 'false');
  if (season !== undefined) url.searchParams.set('season', String(season));
  if (episode !== undefined) url.searchParams.set('episode', String(episode));
  const data = await getJson(url.toString(), { Authorization: `Bearer ${apiKey}` }, 10_000);
  const torrents: any[] = data?.data?.torrents || data?.torrents || [];
  return torrents
    .map((torrent) => ({
      hash: String(torrent.hash || '').toLowerCase(),
      name: String(torrent.raw_title || torrent.title || torrent.name || ''),
      totalSize: Number(torrent.size) || undefined,
      seeders: Number(torrent.last_known_seeders ?? torrent.seeders) || undefined,
      provider: torrent.tracker || undefined,
      origin: 'TorBox',
      multiFile: false
    }))
    .filter((torrent) => HASH.test(torrent.hash) && torrent.name);
}

/** TorrentsDB: a free Stremio addon that gathers YTS, EZTV, 1337x, TorrentCSV, Nyaa and more. */
export const TORRENTSDB_URL = 'https://torrentsdb.com';

/** The Pirate Bay's own API, searched by IMDb id. */
export async function pirateBaySource(imdbId: string): Promise<RawResult[]> {
  const rows: any[] = await getJson(`https://apibay.org/q.php?q=${encodeURIComponent(imdbId)}&cat=200`, {}, 12_000);
  return (Array.isArray(rows) ? rows : [])
    // Only uploads tagged with this title (the search also matches descriptions); "No results" comes back as an all-zero hash.
    .filter((row) => row.imdb === imdbId && HASH.test(String(row.info_hash || '')) && !/^0+$/.test(row.info_hash))
    .map((row) => ({
      hash: String(row.info_hash).toLowerCase(),
      name: String(row.name || ''),
      totalSize: Number(row.size) || undefined,
      seeders: Number(row.seeders) || undefined,
      provider: 'ThePirateBay',
      origin: 'The Pirate Bay',
      multiFile: Number(row.num_files) > 1
    }))
    .filter((row) => row.name);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (text: string) => text
  .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => code[0] === '#'
    ? String.fromCodePoint(code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
    : ENTITIES[code.toLowerCase()] ?? whole);

/** The info hash in a magnet link, as 40 hex characters (some indexers write it in base32). */
export function magnetHash(magnet: string): string | undefined {
  const value = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet)?.[1];
  if (!value) return undefined;
  if (HASH.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) return base32Decode(value).toString('hex');
  return undefined;
}

/** Reads a Torznab feed (Prowlarr, Jackett): one result per item that names its info hash. */
export function parseTorznab(xml: string, origin: string): RawResult[] {
  const results: RawResult[] = [];
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const tag = (name: string) => { const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(item!)?.[1]; return found === undefined ? undefined : decodeXml(found.trim()); };
    const attrs = new Map<string, string>();
    for (const [, name, value] of item!.matchAll(/<torznab:attr\s+name="([^"]+)"\s+value="([^"]*)"/g)) attrs.set(name!.toLowerCase(), decodeXml(value!));
    const magnet = attrs.get('magneturl') ?? [tag('link'), /<enclosure\b[^>]*url="([^"]+)"/.exec(item!)?.[1]].map((value) => value && decodeXml(value)).find((value) => value?.startsWith('magnet:'));
    const hash = (attrs.get('infohash') ?? '').toLowerCase() || (magnet ? magnetHash(magnet) : undefined);
    const name = tag('title');
    if (!hash || !HASH.test(hash) || !name) continue;
    const files = Number(attrs.get('files'));
    results.push({
      hash,
      name,
      totalSize: Number(tag('size') ?? attrs.get('size')) || undefined,
      seeders: Number(attrs.get('seeders')) || undefined,
      provider: tag('jackettindexer') ?? tag('prowlarrindexer') ?? undefined,
      origin,
      multiFile: Number.isFinite(files) && files > 1
    });
  }
  return results;
}

/** Searches one Torznab feed by IMDb id. The address is the indexer's Torznab URL with its apikey. */
export async function torznabSource(feed: string, type: 'movie' | 'series', imdbId: string, season?: number, episode?: number): Promise<RawResult[]> {
  const url = new URL(feed);
  if (!url.pathname.endsWith('/api')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/api`;
  url.searchParams.set('t', type === 'movie' ? 'movie' : 'tvsearch');
  url.searchParams.set('imdbid', imdbId);
  url.searchParams.set('cat', type === 'movie' ? '2000' : '5000');
  if (season !== undefined) url.searchParams.set('season', String(season));
  if (episode !== undefined) url.searchParams.set('ep', String(episode));
  const origin = /jackett/i.test(feed) ? 'Jackett' : /prowlarr|:9696/i.test(feed) ? 'Prowlarr' : url.hostname;
  return parseTorznab(await getText(url.toString(), {}, 20_000), origin);
}

